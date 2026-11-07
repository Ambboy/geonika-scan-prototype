#!/usr/bin/env python3
"""Prepare measured LAS 1.2/PDRF2 points locally; no network or generated geometry.

Requires Python 3.10+, numpy, and libarchive (only for reading a .7z archive).
Example (all paths are operator supplied; do not put source archives in public/):

  python3 -B tools/prepare_scan.py --archive /path/to/las.7z \
    --extract-dir /path/to/private/extracted --output-dir public/data \
    --evidence-dir /path/to/private/evidence \
    --expect-archive-sha256 <sha256> --exterior-points 600000 --interior-points 900000

Each equal-sized source-index stratum contributes one SplitMix64-selected point.
This visits the entire acquisition sequence, not its prefix, and avoids a periodic
stride. Whole-source bounds, RGB statistics, SHA256, and height histograms are
computed in bounded chunks. Only the selected records are kept in memory.
RGB16 is rounded to RGB8 by (value + 128) // 257; a source whose full RGB range
already fits 8 bits is copied without attenuation. No colors are fabricated.
The public manifest deliberately contains no filesystem paths or source URLs.
"""
from __future__ import annotations

import argparse
import ctypes as C
import ctypes.util
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import struct
import zlib

import numpy as np

LAS_DTYPE = np.dtype({
    "names": ["xyz", "rgb"], "formats": [("<i4", 3), ("<u2", 3)],
    "offsets": [0, 20], "itemsize": 26,
})
OUTPUT_DTYPE = np.dtype({
    "names": ["xyz", "rgb", "alpha"],
    "formats": [("<f4", 3), ("u1", 3), "u1"],
    "offsets": [0, 12, 15], "itemsize": 16,
})
FORMAT = "xyz-f32-rgb8-stride16"
DEFAULT_SEED = 20261107


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def read_las_header(path: Path) -> dict:
    path = Path(path)
    actual = path.stat().st_size
    with path.open("rb") as stream:
        data = stream.read(227)
    if len(data) != 227 or data[:4] != b"LASF":
        raise ValueError("Not a complete LAS header")
    if data[24:26] != b"\x01\x02":
        raise ValueError("Only uncompressed LAS 1.2 is supported")
    header_bytes, data_offset = struct.unpack_from("<HI", data, 94)
    point_format, record_bytes, count = struct.unpack_from("<BHI", data, 104)
    if point_format != 2 or record_bytes != 26:
        raise ValueError("Only uncompressed PDRF2, record length 26 is supported")
    if header_bytes < 227 or data_offset < header_bytes or not count:
        raise ValueError("Invalid header offset or zero source point count")
    expected = data_offset + count * record_bytes
    if expected != actual:
        raise ValueError(f"LAS size mismatch: expected {expected}, actual {actual}")
    scale = np.asarray(struct.unpack_from("<3d", data, 131))
    origin = np.asarray(struct.unpack_from("<3d", data, 155))
    packed_bounds = struct.unpack_from("<6d", data, 179)
    low = np.asarray(packed_bounds[1::2])
    high = np.asarray(packed_bounds[0::2])
    if not np.isfinite(np.concatenate([scale, origin, low, high])).all():
        raise ValueError("Non-finite LAS scale, offset, or bounds")
    if np.any(scale <= 0) or np.any(low > high):
        raise ValueError("Invalid LAS scale or bounds")
    return {"pointCount": count, "dataOffset": data_offset, "recordBytes": record_bytes,
            "scale": scale, "origin": origin, "bounds": {"min": low.tolist(), "max": high.tolist()},
            "expectedBytes": expected, "actualBytes": actual}


def stratified_indices(source_count: int, point_count: int, seed: int = DEFAULT_SEED) -> np.ndarray:
    if not 0 < point_count <= source_count or not 0 <= seed < 2**64:
        raise ValueError("Require 0 < sample <= source and an unsigned 64-bit seed")
    k = np.arange(point_count, dtype=np.uint64)
    starts = k * np.uint64(source_count) // np.uint64(point_count)
    ends = (k + np.uint64(1)) * np.uint64(source_count) // np.uint64(point_count)
    with np.errstate(over="ignore"):
        value = k + np.uint64(seed) + np.uint64(0x9E3779B97F4A7C15)
        value = (value ^ (value >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        value = (value ^ (value >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        value ^= value >> np.uint64(31)
    return (starts + value % (ends - starts)).astype(np.int64)


def prepare_cloud(source: Path, destination: Path, point_count: int, *, seed=DEFAULT_SEED,
                  chunk_points=1_000_000) -> dict:
    """Validate every source record, then export a deterministic measured subset."""
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve():
        raise ValueError("Source and destination must differ")
    if chunk_points < 1:
        raise ValueError("chunk_points must be positive")
    header = read_las_header(source)
    count = header["pointCount"]
    indices = stratified_indices(count, point_count, seed)
    selected = np.empty(point_count, dtype=LAS_DTYPE)
    low = np.full(3, np.iinfo(np.int32).max, dtype=np.int64)
    high = np.full(3, np.iinfo(np.int32).min, dtype=np.int64)
    rgb_low, rgb_high = np.full(3, 65535), np.zeros(3, dtype=np.int64)
    nonzero = nongrey = 0
    expanded8 = True
    hist_step = 0.05
    hist_start = math.floor(header["bounds"]["min"][2] / hist_step) * hist_step
    hist_bins = int(math.ceil((header["bounds"]["max"][2] - hist_start) / hist_step)) + 1
    if hist_bins > 1_000_000:
        raise ValueError("Unreasonable vertical extent for a 5 cm histogram")
    histogram = np.zeros(hist_bins, dtype=np.int64)
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        prefix_left = header["dataOffset"]
        while prefix_left:
            block = stream.read(min(prefix_left, 1024 * 1024))
            if not block:
                raise ValueError("Truncated LAS prefix")
            digest.update(block)
            prefix_left -= len(block)
        for start in range(0, count, chunk_points):
            size = min(chunk_points, count - start)
            block = stream.read(size * 26)
            if len(block) != size * 26:
                raise ValueError("Truncated point data")
            digest.update(block)
            records = np.frombuffer(block, dtype=LAS_DTYPE)
            low = np.minimum(low, records["xyz"].min(axis=0))
            high = np.maximum(high, records["xyz"].max(axis=0))
            colors = records["rgb"]
            rgb_low = np.minimum(rgb_low, colors.min(axis=0))
            rgb_high = np.maximum(rgb_high, colors.max(axis=0))
            nonzero += int(np.count_nonzero(np.any(colors != 0, axis=1)))
            nongrey += int(np.count_nonzero((colors[:, 0] != colors[:, 1]) | (colors[:, 1] != colors[:, 2])))
            expanded8 = expanded8 and bool(np.all(colors % 257 == 0))
            heights = records["xyz"][:, 2].astype(np.float64) * header["scale"][2] + header["origin"][2]
            bins = np.floor((heights - hist_start) / hist_step).astype(np.int64)
            if np.any(bins < 0) or np.any(bins >= hist_bins):
                raise ValueError("A source height lies outside its declared bounds")
            histogram += np.bincount(bins, minlength=hist_bins)
            left, right = np.searchsorted(indices, [start, start + size])
            selected[left:right] = records[indices[left:right] - start]
        if stream.read(1):
            raise ValueError("Unexpected trailing LAS bytes")
    bounds = {"min": (low * header["scale"] + header["origin"]).tolist(),
              "max": (high * header["scale"] + header["origin"]).tolist()}
    for edge in ("min", "max"):
        if not np.allclose(bounds[edge], header["bounds"][edge], rtol=0, atol=1e-8):
            raise ValueError("Whole-source observed bounds differ from the LAS header")
    xyz = selected["xyz"].astype(np.float64) * header["scale"] + header["origin"]
    if not np.isfinite(xyz).all():
        raise ValueError("Non-finite sampled coordinates")
    output = np.empty(point_count, dtype=OUTPUT_DTYPE)
    output["xyz"] = xyz
    nearest = output["xyz"].copy()
    # A round-to-nearest float32 extremum can lie a few micrometres outside
    # the measured double-precision bounds. Use the adjacent inward float32
    # in that case only; this is quantization, not new or displaced geometry.
    lower = np.asarray(bounds["min"], dtype=np.float32)
    upper = np.asarray(bounds["max"], dtype=np.float32)
    lower = np.where(lower.astype(np.float64) < bounds["min"],
                     np.nextafter(lower, np.float32(np.inf)), lower)
    upper = np.where(upper.astype(np.float64) > bounds["max"],
                     np.nextafter(upper, np.float32(-np.inf)), upper)
    if np.any(lower > upper):
        raise ValueError("Source bounds contain no representable float32 coordinate")
    output["xyz"] = np.clip(output["xyz"], lower, upper)
    inward_adjusted = int(np.count_nonzero(output["xyz"] != nearest))
    rgb_mode = "uint8-stored-in-uint16" if int(rgb_high.max()) <= 255 else "round-uint16-div257"
    output["rgb"] = (selected["rgb"] if rgb_mode == "uint8-stored-in-uint16" else
                     (selected["rgb"].astype(np.uint32) + 128) // 257)
    output["alpha"] = 255
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    output.tofile(temporary)
    os.replace(temporary, destination)
    xyz32 = output["xyz"].astype(np.float64)
    if not (np.all(xyz32 >= np.asarray(bounds["min"])) and
            np.all(xyz32 <= np.asarray(bounds["max"]))):
        raise ValueError("Export coordinates are outside source bounds")
    if destination.stat().st_size != point_count * 16:
        raise ValueError("Export byte length mismatch")
    # Read actual disk bytes back; a successful write is not the verification.
    readback = np.fromfile(destination, dtype=OUTPUT_DTYPE)
    if not np.array_equal(readback, output) or not np.isfinite(readback["xyz"]).all():
        raise ValueError("Export readback differs or contains non-finite coordinates")
    quantiles = [0, 0.001, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 0.999, 1]
    top_bins = np.argsort(histogram)[-20:][::-1]
    source_sha = digest.hexdigest()
    return {"cloud": {"sourcePointCount": count, "pointCount": point_count,
                       "byteLength": destination.stat().st_size, "sha256": sha256_file(destination),
                       "bounds": bounds, "format": FORMAT},
            "evidence": {"sourceSha256": source_sha, "actualBytes": header["actualBytes"],
                         "expectedBytes": header["expectedBytes"], "sourceCountObserved": count,
                         "headerBounds": header["bounds"], "observedSourceBounds": bounds,
                         "sampleBounds": {"min": xyz32.min(axis=0).tolist(), "max": xyz32.max(axis=0).tolist()},
                         "sampleQuantiles": {str(q): v for q, v in zip(quantiles, np.quantile(xyz32, quantiles, axis=0).tolist())},
                         "maxFloat32Error": float(np.max(np.abs(xyz32 - xyz))),
                         "sourceRGB": {"min": rgb_low.tolist(), "max": rgb_high.tolist(),
                                       "nonzeroCount": nonzero, "nonGreyCount": nongrey,
                                       "allChannelsMultiplesOf257": expanded8},
                         "sampleRGB8": {"min": output["rgb"].min(axis=0).tolist(),
                                        "max": output["rgb"].max(axis=0).tolist(),
                                        "nonzeroCount": int(np.count_nonzero(np.any(output["rgb"] != 0, axis=1))),
                                        "nonGreyCount": int(np.count_nonzero((output["rgb"][:, 0] != output["rgb"][:, 1]) | (output["rgb"][:, 1] != output["rgb"][:, 2])))},
                         "colorEncoding": rgb_mode, "finiteCoordinates": True,
                         "withinSourceBounds": True,
                         "float32Encoding": "round-to-nearest, constrain extrema to the nearest inward float32",
                         "inwardAdjustedCoordinateCount": inward_adjusted,
                         "alphaAll255": bool(np.all(readback["alpha"] == 255)),
                         "sampling": {"algorithm": "one-splitmix64-index-per-equal-index-stratum-v1",
                                      "seed": seed, "firstSourceIndex": int(indices[0]), "lastSourceIndex": int(indices[-1]),
                                      "indexSha256": hashlib.sha256(indices.astype("<i8").tobytes()).hexdigest(),
                                      "indexDecileCounts": np.bincount(indices * 10 // count, minlength=10).tolist()},
                         "heightHistogram": {"start": hist_start, "step": hist_step,
                                             "counts": histogram.tolist(),
                                             "largestBins": [{"zMin": hist_start + int(i) * hist_step,
                                                               "zMax": hist_start + (int(i) + 1) * hist_step,
                                                               "count": int(histogram[i])} for i in top_bins]}}}


def extract_archive(archive_path: Path, extract_dir: Path, members: dict, archive_sha: str,
                    receipt_path: Path, reuse: bool = False) -> dict:
    """Extract only explicitly named regular files; never trust archive pathnames."""
    for member in members.values():
        path = PurePosixPath(member)
        if path.is_absolute() or ".." in path.parts or "\\" in member:
            raise ValueError("Unsafe archive member name")
    if len(set(members.values())) != len(members):
        raise ValueError("Archive members must be distinct")
    extract_dir.mkdir(parents=True, exist_ok=True)
    if reuse:
        previous = json.loads(receipt_path.read_text(encoding="utf-8"))
        if previous["archiveSha256"] != archive_sha:
            raise ValueError("Extraction receipt belongs to a different archive")
        for cloud_id, member in members.items():
            item = previous["files"][cloud_id]
            path = extract_dir / (cloud_id + ".las")
            if item["member"] != member or path.stat().st_size != item["byteLength"] or sha256_file(path) != item["sha256"]:
                raise ValueError("Existing extracted LAS does not match its verified receipt")
        return previous
    library_name = ctypes.util.find_library("archive")
    if not library_name:
        raise RuntimeError("libarchive is required to read .7z; install it locally")
    lib = C.CDLL(library_name)
    def api(name, result, arguments):
        function = getattr(lib, name)
        function.restype, function.argtypes = result, arguments
        return function
    new = api("archive_read_new", C.c_void_p, [])
    support = api("archive_read_support_format_7zip", C.c_int, [C.c_void_p])
    filters = api("archive_read_support_filter_all", C.c_int, [C.c_void_p])
    open_file = api("archive_read_open_filename", C.c_int, [C.c_void_p, C.c_char_p, C.c_size_t])
    next_header = api("archive_read_next_header", C.c_int, [C.c_void_p, C.POINTER(C.c_void_p)])
    pathname = api("archive_entry_pathname_utf8", C.c_char_p, [C.c_void_p])
    entry_size = api("archive_entry_size", C.c_int64, [C.c_void_p])
    filetype = api("archive_entry_filetype", C.c_uint, [C.c_void_p])
    read_data = api("archive_read_data", C.c_ssize_t, [C.c_void_p, C.c_void_p, C.c_size_t])
    skip = api("archive_read_data_skip", C.c_int, [C.c_void_p])
    error = api("archive_error_string", C.c_char_p, [C.c_void_p])
    free = api("archive_read_free", C.c_int, [C.c_void_p])
    archive = new()
    if not archive:
        raise RuntimeError("Could not allocate libarchive reader")
    def check(status):
        if status < 0:
            message = error(archive)
            raise RuntimeError(message.decode(errors="replace") if message else f"Archive error {status}")
        return status
    result = {"archiveSha256": archive_sha, "files": {}}
    try:
        check(support(archive))
        check(filters(archive))
        check(open_file(archive, os.fsencode(archive_path), 128 * 1024))
        entry = C.c_void_p()
        buffer = C.create_string_buffer(4 * 1024 * 1024)
        lookup = {member: cloud_id for cloud_id, member in members.items()}
        while True:
            status = next_header(archive, C.byref(entry))
            if status == 1:
                break
            check(status)
            name_bytes = pathname(entry)
            name = name_bytes.decode("utf-8") if name_bytes else ""
            if name not in lookup:
                check(skip(archive))
                continue
            cloud_id = lookup[name]
            if cloud_id in result["files"] or filetype(entry) != 0o100000:
                raise ValueError("Requested archive member is duplicated or not a regular file")
            expected = entry_size(entry)
            target = extract_dir / (cloud_id + ".las")
            part = target.with_name(target.name + ".part")
            digest, size = hashlib.sha256(), 0
            with part.open("wb") as output:
                while True:
                    length = check(read_data(archive, buffer, len(buffer)))
                    if not length:
                        break
                    block = buffer.raw[:length]
                    output.write(block)
                    digest.update(block)
                    size += length
            if size != expected:
                raise ValueError("Extracted member length does not match the archive")
            os.replace(part, target)
            result["files"][cloud_id] = {"member": name, "byteLength": size, "sha256": digest.hexdigest()}
            print(json.dumps({"extracted": cloud_id, "byteLength": size, "sha256": digest.hexdigest()}), flush=True)
    finally:
        free(archive)
    if set(result["files"]) != set(members):
        raise ValueError("Requested LAS member is missing from the archive")
    write_json(receipt_path, result)
    return result


# Small, dependency-free bitmap text for the private PNG evidence, not the site.
_FONT = {
    "A":"01110 10001 10001 11111 10001 10001 10001", "B":"11110 10001 10001 11110 10001 10001 11110",
    "C":"01111 10000 10000 10000 10000 10000 01111", "D":"11110 10001 10001 10001 10001 10001 11110",
    "E":"11111 10000 10000 11110 10000 10000 11111", "F":"11111 10000 10000 11110 10000 10000 10000",
    "G":"01111 10000 10000 10111 10001 10001 01111", "H":"10001 10001 10001 11111 10001 10001 10001",
    "I":"11111 00100 00100 00100 00100 00100 11111", "J":"00111 00010 00010 00010 10010 10010 01100",
    "K":"10001 10010 10100 11000 10100 10010 10001", "L":"10000 10000 10000 10000 10000 10000 11111",
    "M":"10001 11011 10101 10101 10001 10001 10001", "N":"10001 11001 10101 10011 10001 10001 10001",
    "O":"01110 10001 10001 10001 10001 10001 01110", "P":"11110 10001 10001 11110 10000 10000 10000",
    "Q":"01110 10001 10001 10001 10101 10010 01101", "R":"11110 10001 10001 11110 10100 10010 10001",
    "S":"01111 10000 10000 01110 00001 00001 11110", "T":"11111 00100 00100 00100 00100 00100 00100",
    "U":"10001 10001 10001 10001 10001 10001 01110", "V":"10001 10001 10001 10001 10001 01010 00100",
    "W":"10001 10001 10001 10101 10101 11011 10001", "X":"10001 10001 01010 00100 01010 10001 10001",
    "Y":"10001 10001 01010 00100 00100 00100 00100", "Z":"11111 00001 00010 00100 01000 10000 11111",
    "0":"01110 10011 10101 10101 11001 10001 01110", "1":"00100 01100 00100 00100 00100 00100 01110",
    "2":"01110 10001 00001 00010 00100 01000 11111", "3":"11110 00001 00001 01110 00001 00001 11110",
    "4":"00010 00110 01010 10010 11111 00010 00010", "5":"11111 10000 10000 11110 00001 00001 11110",
    "6":"01110 10000 10000 11110 10001 10001 01110", "7":"11111 00001 00010 00100 01000 01000 01000",
    "8":"01110 10001 10001 01110 10001 10001 01110", "9":"01110 10001 10001 01111 00001 00001 01110",
    "-":"00000 00000 00000 11111 00000 00000 00000", ".":"00000 00000 00000 00000 00000 00110 00110",
    "=":"00000 00000 11111 00000 11111 00000 00000", ":":"00000 00110 00110 00000 00110 00110 00000",
    "+":"00000 00100 00100 11111 00100 00100 00000", "/":"00001 00010 00010 00100 01000 01000 10000",
}


def _text(image, x, y, text, scale=2, color=(210, 220, 230)):
    for character in text.upper():
        pattern = _FONT.get(character, "00000 " * 6 + "00000").split()
        for row, bits in enumerate(pattern):
            for column, bit in enumerate(bits):
                if bit == "1":
                    image[y + row*scale:y + (row+1)*scale, x + column*scale:x + (column+1)*scale] = color
        x += 6 * scale


def write_png(path: Path, image: np.ndarray):
    height, width, _ = image.shape
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    scanlines = b"".join(b"\x00" + row.tobytes() for row in image)
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(scanlines, 6)) + chunk(b"IEND", b""))
    Path(path).write_bytes(data)


def _panel(records, width=780, height=510, *, title, projection="top", zrange=None):
    image = np.full((height, width, 3), (12, 18, 27), dtype=np.uint8)
    xyz, rgb = records["xyz"].astype(np.float64), records["rgb"]
    if zrange:
        mask = (xyz[:, 2] >= zrange[0]) & (xyz[:, 2] < zrange[1])
        xyz, rgb = xyz[mask], rgb[mask]
    _text(image, 18, 14, title, 2)
    _text(image, 18, 38, f"N={len(xyz)} REAL RGB - Z UP", 1)
    if not len(xyz):
        return image
    if projection == "top":
        uv, depth = xyz[:, :2], xyz[:, 2]
    else:
        # Looking from +X,-Y,+Z towards the scene, with a true Z-up frame.
        right = np.asarray([0.8, 0.6, 0.0])
        up = np.asarray([-0.3, 0.4, math.sqrt(0.75)])
        toward = np.cross(right, up)
        uv, depth = np.column_stack([xyz @ right, xyz @ up]), xyz @ toward
    low, high = uv.min(axis=0), uv.max(axis=0)
    span = np.maximum(high - low, 1e-6)
    scale = min((width - 40) / span[0], (height - 90) / span[1])
    pixels = (uv - (low + high) / 2) * scale + np.asarray([width / 2, (height + 60) / 2])
    px = np.clip(np.rint(pixels[:, 0]).astype(np.int32), 0, width - 1)
    py = np.clip(height - np.rint(pixels[:, 1]).astype(np.int32), 65, height - 1)
    # Explicit z-buffer by pixel, avoiding undefined repeated-index assignment.
    keys = py.astype(np.int64) * width + px
    order = np.lexsort((depth, keys))
    last = np.r_[keys[order][1:] != keys[order][:-1], True]
    visible = order[last]
    image[py[visible], px[visible]] = rgb[visible]
    return image


def create_previews(output_dir: Path, evidence_dir: Path) -> list[str]:
    clouds = {cloud_id: np.fromfile(output_dir / (cloud_id + ".bin"), dtype=OUTPUT_DTYPE)
              for cloud_id in ("exterior", "interior")}
    rows = []
    for projection, zrange, label in [("top", None, "TOP XY ALL HEIGHTS"),
                                      ("oblique", None, "OBLIQUE ALL HEIGHTS"),
                                      ("top", (-0.5, 1.8), "TOP SLICE Z -0.5 TO 1.8")]:
        rows.append(np.concatenate([_panel(clouds[c], title=f"{c} {label}", projection=projection, zrange=zrange)
                                    for c in clouds], axis=1))
    overview = evidence_dir / "overview.png"
    write_png(overview, np.concatenate(rows, axis=0))
    paths = [str(overview.resolve())]
    for cloud_id, records in clouds.items():
        rows = []
        for z1, z2 in [(-1.0, 0.0), (0.0, 0.5), (0.5, 1.2), (1.2, 2.0), (2.0, 3.0), (3.0, 5.0)]:
            rows.append(_panel(records, title=f"{cloud_id} XY Z {z1:.1f} TO {z2:.1f}", zrange=(z1, z2)))
        grid = np.concatenate([np.concatenate(rows[i:i+2], axis=1) for i in (0, 2, 4)], axis=0)
        path = evidence_dir / (cloud_id + "-height-slices.png")
        write_png(path, grid)
        paths.append(str(path.resolve()))
    return paths


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--extract-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("public/data"))
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--expect-archive-sha256")
    parser.add_argument("--exterior-member", default="las/1_снаружи.las")
    parser.add_argument("--interior-member", default="las/1_внутри.las")
    parser.add_argument("--exterior-points", type=int, default=600000)
    parser.add_argument("--interior-points", type=int, default=900000)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--chunk-points", type=int, default=1_000_000)
    parser.add_argument("--reuse-extracted", action="store_true", help="Rehash source LAS and require a matching extraction receipt")
    args = parser.parse_args(argv)
    output_dir, evidence_dir, extract_dir = args.output_dir.resolve(), args.evidence_dir.resolve(), args.extract_dir.resolve()
    if evidence_dir.is_relative_to(output_dir) or extract_dir.is_relative_to(output_dir) or args.archive.resolve().is_relative_to(output_dir):
        parser.error("Keep evidence and original inputs outside the public data directory")
    for value in (args.exterior_points, args.interior_points, args.chunk_points):
        if value <= 0:
            parser.error("Point counts and chunk size must be positive")
    if args.expect_archive_sha256 and (len(args.expect_archive_sha256) != 64 or
                                      any(c not in "0123456789abcdef" for c in args.expect_archive_sha256)):
        parser.error("Expected archive SHA256 must be 64 lowercase hexadecimal characters")
    evidence_dir.mkdir(parents=True, exist_ok=True)
    archive_sha = sha256_file(args.archive)
    if args.expect_archive_sha256 and args.expect_archive_sha256 != archive_sha:
        raise ValueError("Archive SHA256 does not match the expected value")
    print(json.dumps({"archiveSha256": archive_sha, "archiveBytes": args.archive.stat().st_size}), flush=True)
    extraction = extract_archive(args.archive, extract_dir,
                                 {"exterior": args.exterior_member, "interior": args.interior_member},
                                 archive_sha, evidence_dir / "extraction-receipt.json", args.reuse_extracted)
    manifest = {"version": 1, "coordinateSystem": "right-handed-z-up", "sourcePointCount": 0,
                "sourceArchiveSha256": archive_sha, "bounds": None, "interiorBounds": None, "clouds": []}
    evidence = {"archiveSha256": archive_sha, "archiveBytes": args.archive.stat().st_size,
                "binaryLayout": "LE float32 XYZ bytes 0..11; RGB8 bytes 12..14; alpha=255 byte 15",
                "sampling": "One original record per equal source-index stratum, SplitMix64, sorted in source order",
                "coordinateNote": "Original right-handed Z-up coordinates; unit interpreted as metres, geodetic CRS not asserted",
                "clouds": {}}
    for cloud_id, label, points in [("exterior", "Снаружи", args.exterior_points), ("interior", "Внутри", args.interior_points)]:
        result = prepare_cloud(extract_dir / (cloud_id + ".las"), output_dir / (cloud_id + ".bin"), points,
                               seed=args.seed, chunk_points=args.chunk_points)
        if result["evidence"]["sourceSha256"] != extraction["files"][cloud_id]["sha256"]:
            raise ValueError("Source changed after archive extraction")
        cloud = {"id": cloud_id, "label": label, "file": cloud_id + ".bin", **result["cloud"]}
        manifest["clouds"].append(cloud)
        manifest["sourcePointCount"] += cloud["sourcePointCount"]
        evidence["clouds"][cloud_id] = result["evidence"]
        print(json.dumps({"prepared": cloud_id, **cloud}, ensure_ascii=False), flush=True)
    manifest["bounds"] = {"min": np.min([c["bounds"]["min"] for c in manifest["clouds"]], axis=0).tolist(),
                          "max": np.max([c["bounds"]["max"] for c in manifest["clouds"]], axis=0).tolist()}
    manifest["interiorBounds"] = next(c["bounds"] for c in manifest["clouds"] if c["id"] == "interior")
    write_json(output_dir / "manifest.json", manifest)
    if json.loads((output_dir / "manifest.json").read_text(encoding="utf-8")) != manifest:
        raise ValueError("Manifest readback differs")
    evidence["previews"] = create_previews(output_dir, evidence_dir)
    evidence["publicAssets"] = {name: {"sha256": sha256_file(output_dir / name), "byteLength": (output_dir / name).stat().st_size}
                                for name in ("manifest.json", "exterior.bin", "interior.bin")}
    write_json(evidence_dir / "data-evidence.json", evidence)
    print(json.dumps({"complete": True, "sourcePointCount": manifest["sourcePointCount"],
                      "samplePointCount": sum(c["pointCount"] for c in manifest["clouds"]),
                      "totalBinaryBytes": sum(c["byteLength"] for c in manifest["clouds"]),
                      "previews": evidence["previews"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
