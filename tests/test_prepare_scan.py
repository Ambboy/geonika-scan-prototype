"""Local preparation regressions. Tiny LAS fixtures are test inputs, never site data."""
from __future__ import annotations

import ctypes as C
import ctypes.util
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

import numpy as np

SPEC = importlib.util.spec_from_file_location(
    "prepare_scan", Path(__file__).resolve().parents[1] / "tools" / "prepare_scan.py"
)
assert SPEC is not None and SPEC.loader is not None
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def write_las(path: Path, xyz=None, rgb=None, scale=(0.01, 0.02, 0.005), offset=(2.0, -3.0, 0.5)):
    """Write an uncompressed LAS 1.2/PDRF2 fixture with correct layout and bounds."""
    if xyz is None:
        xyz = [(-150, 3, 0), (0, -8, 20), (23, 101, -13), (77, 18, 640)]
    if rgb is None:
        rgb = [(0, 257, 65535), (514, 32768, 1285), (65535, 0, 1028), (2570, 65535, 0)]
    coords = np.asarray(xyz, dtype=np.int32)
    real = coords.astype(np.float64) * scale + offset
    low, high = real.min(axis=0), real.max(axis=0)
    header = bytearray(227)
    header[:4] = b"LASF"
    header[24:26] = bytes([1, 2])
    struct.pack_into("<HII", header, 94, 227, 227, 0)
    struct.pack_into("<BHI", header, 104, 2, 26, len(coords))
    struct.pack_into("<5I", header, 111, len(coords), 0, 0, 0, 0)
    struct.pack_into("<3d", header, 131, *scale)
    struct.pack_into("<3d", header, 155, *offset)
    struct.pack_into("<6d", header, 179, high[0], low[0], high[1], low[1], high[2], low[2])
    with path.open("wb") as stream:
        stream.write(header)
        for coordinate, color in zip(coords, rgb, strict=True):
            # XYZ, intensity, return flags, classification, angle, user, source, RGB.
            stream.write(struct.pack("<3iHBBbBH3H", *coordinate, 0, 9, 1, 0, 0, 0, *color))
    return real, np.asarray(rgb, dtype=np.uint16)


def write_7z(path: Path, members: dict[str, bytes]):
    """Exercise the actual archive reader against a tiny real 7z container."""
    library = ctypes.util.find_library("archive")
    if not library:
        raise RuntimeError("Archive acceptance requires libarchive")
    lib = C.CDLL(library)
    def api(name, result, arguments):
        function = getattr(lib, name)
        function.restype, function.argtypes = result, arguments
        return function
    new = api("archive_write_new", C.c_void_p, [])
    format7z = api("archive_write_set_format_7zip", C.c_int, [C.c_void_p])
    open_file = api("archive_write_open_filename", C.c_int, [C.c_void_p, C.c_char_p])
    entry_new = api("archive_entry_new", C.c_void_p, [])
    set_name = api("archive_entry_set_pathname_utf8", None, [C.c_void_p, C.c_char_p])
    set_size = api("archive_entry_set_size", None, [C.c_void_p, C.c_int64])
    set_type = api("archive_entry_set_filetype", None, [C.c_void_p, C.c_uint])
    set_perm = api("archive_entry_set_perm", None, [C.c_void_p, C.c_int])
    header = api("archive_write_header", C.c_int, [C.c_void_p, C.c_void_p])
    data = api("archive_write_data", C.c_ssize_t, [C.c_void_p, C.c_void_p, C.c_size_t])
    entry_free = api("archive_entry_free", None, [C.c_void_p])
    close = api("archive_write_close", C.c_int, [C.c_void_p])
    free = api("archive_write_free", C.c_int, [C.c_void_p])
    archive = new()
    try:
        assert format7z(archive) == 0
        assert open_file(archive, os.fsencode(path)) == 0
        for name, content in members.items():
            entry = entry_new()
            try:
                set_name(entry, name.encode("utf-8"))
                set_size(entry, len(content))
                set_type(entry, 0o100000)
                set_perm(entry, 0o644)
                assert header(archive, entry) == 0
                buffer = C.create_string_buffer(content)
                assert data(archive, buffer, len(content)) == len(content)
            finally:
                entry_free(entry)
        assert close(archive) == 0
    finally:
        free(archive)


class PrepareScanTests(unittest.TestCase):
    def test_real_las_records_become_exact_stride16_xyz_and_color(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temporary:
            root = Path(temporary)
            source, output = root / "fixture.las", root / "fixture.bin"
            # Binary-exact coordinates isolate record layout and RGB conversion;
            # nonrepresentable extrema are exercised in the dedicated bounds test.
            real, rgb16 = write_las(source, scale=(0.25, 0.5, 0.125))
            result = prepare.prepare_cloud(source, output, 4, seed=17, chunk_points=2)
            self.assertEqual(output.stat().st_size, 4 * 16)
            records = np.fromfile(output, dtype=np.dtype({
                "names": ["xyz", "rgb", "alpha"],
                "formats": [("<f4", 3), ("u1", 3), "u1"],
                "offsets": [0, 12, 15], "itemsize": 16,
            }))
            np.testing.assert_array_equal(records["xyz"], real.astype("<f4"))
            np.testing.assert_array_equal(records["rgb"], ((rgb16.astype(np.uint32) + 128) // 257).astype(np.uint8))
            np.testing.assert_array_equal(records["alpha"], np.full(4, 255, dtype=np.uint8))
            self.assertEqual(result["cloud"]["pointCount"], 4)
            self.assertEqual(result["cloud"]["sourcePointCount"], 4)
            self.assertEqual(result["evidence"]["actualBytes"], 227 + 4 * 26)
            self.assertEqual(result["evidence"]["expectedBytes"], 227 + 4 * 26)
            np.testing.assert_array_equal(result["cloud"]["bounds"]["min"], real.min(axis=0))
            np.testing.assert_array_equal(result["cloud"]["bounds"]["max"], real.max(axis=0))


    def test_float32_coordinates_stay_strictly_within_measured_source_bounds(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temporary:
            root = Path(temporary)
            source, output = root / "fixture.las", root / "fixture.bin"
            real, _ = write_las(source)
            prepare.prepare_cloud(source, output, 4, seed=17, chunk_points=2)
            records = np.fromfile(output, dtype=prepare.OUTPUT_DTYPE)
            self.assertTrue(np.all(records["xyz"].astype(np.float64) >= real.min(axis=0)),
                            "Float32 rounding escaped the measured minimum")
            self.assertTrue(np.all(records["xyz"].astype(np.float64) <= real.max(axis=0)),
                            "Float32 rounding escaped the measured maximum")
            self.assertLess(np.max(np.abs(records["xyz"] - real)), 1e-5)


    def test_stratified_sampling_is_reproducible_unique_and_covers_source(self):
        indices = prepare.stratified_indices(10007, 301, 17)
        np.testing.assert_array_equal(indices, prepare.stratified_indices(10007, 301, 17))
        self.assertFalse(np.array_equal(indices, prepare.stratified_indices(10007, 301, 18)))
        self.assertTrue(np.all(indices[1:] > indices[:-1]))
        self.assertLess(indices[0], 34)
        self.assertGreater(indices[-1], 9972)
        starts = np.arange(301, dtype=np.int64) * 10007 // 301
        ends = (np.arange(301, dtype=np.int64) + 1) * 10007 // 301
        self.assertTrue(np.all(indices >= starts))
        self.assertTrue(np.all(indices < ends))
        self.assertEqual(len(indices), 301)

    def test_chunk_size_does_not_change_output_and_uint8_colors_stay_real(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temporary:
            root = Path(temporary)
            source = root / "fixture.las"
            rgb = [(0, 12, 255), (34, 56, 78), (90, 120, 170), (10, 20, 30)]
            write_las(source, rgb=rgb)
            a = prepare.prepare_cloud(source, root / "a.bin", 3, seed=19, chunk_points=1)
            b = prepare.prepare_cloud(source, root / "b.bin", 3, seed=19, chunk_points=3)
            self.assertEqual((root / "a.bin").read_bytes(), (root / "b.bin").read_bytes())
            self.assertEqual(a, b)
            records = np.fromfile(root / "a.bin", dtype=prepare.OUTPUT_DTYPE)
            indices = prepare.stratified_indices(4, 3, 19)
            np.testing.assert_array_equal(records["rgb"], np.asarray(rgb, dtype=np.uint8)[indices])
            self.assertEqual(a["evidence"]["colorEncoding"], "uint8-stored-in-uint16")
            self.assertEqual(a["evidence"]["sourceSha256"], hashlib.sha256(source.read_bytes()).hexdigest())

    def test_invalid_counts_seeds_and_chunks_are_refused(self):
        for source, count, seed in [(4, 0, 1), (4, 5, 1), (4, 2, -1), (4, 2, 2**64)]:
            with self.subTest(source=source, count=count, seed=seed), self.assertRaises(ValueError):
                prepare.stratified_indices(source, count, seed)
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temporary:
            root = Path(temporary)
            write_las(root / "fixture.las")
            with self.assertRaisesRegex(ValueError, "chunk"):
                prepare.prepare_cloud(root / "fixture.las", root / "a.bin", 2, chunk_points=0)
            with self.assertRaisesRegex(ValueError, "differ"):
                prepare.prepare_cloud(root / "fixture.las", root / "fixture.las", 2)

    def test_bad_header_size_format_and_nonfinite_metadata_are_refused(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temporary:
            source = Path(temporary) / "fixture.las"
            write_las(source)
            valid = source.read_bytes()
            variants = [valid[:-1], valid + b"x", b"NOPE" + valid[4:]]
            for index, patch in [(104, bytes([3])), (24, bytes([2]))]:
                variants.append(valid[:index] + patch + valid[index+len(patch):])
            data = bytearray(valid)
            struct.pack_into("<d", data, 131, float("nan"))
            variants.append(bytes(data))
            for data in variants:
                with self.subTest(bytes=len(data)):
                    source.write_bytes(data)
                    with self.assertRaises(ValueError):
                        prepare.read_las_header(source)

    def test_bounds_are_measured_from_every_record_not_just_sample(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temporary:
            root = Path(temporary)
            source = root / "fixture.las"
            real, _ = write_las(source)
            result = prepare.prepare_cloud(source, root / "a.bin", 2, seed=17, chunk_points=1)
            self.assertEqual(result["cloud"]["bounds"]["min"], real.min(axis=0).tolist())
            self.assertEqual(result["cloud"]["bounds"]["max"], real.max(axis=0).tolist())
            self.assertEqual(sum(result["evidence"]["heightHistogram"]["counts"]), 4)
            data = bytearray(source.read_bytes())
            struct.pack_into("<d", data, 179, real[:, 0].max() + 0.1)
            source.write_bytes(data)
            with self.assertRaisesRegex(ValueError, "observed bounds"):
                prepare.prepare_cloud(source, root / "bad.bin", 2, seed=17)
            self.assertFalse((root / "bad.bin").exists())

    def test_archive_member_paths_are_never_used_as_output_paths(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temporary:
            root = Path(temporary)
            for member in ("../escape.las", "/absolute.las", "las/../../escape.las", "las\\escape.las"):
                with self.subTest(member=member), self.assertRaisesRegex(ValueError, "Unsafe"):
                    prepare.extract_archive(root / "missing.7z", root / "extracted", {"exterior": member}, "0"*64, root / "receipt.json")
            self.assertFalse((root / "extracted").exists())

    def test_public_cli_reads_real_7z_then_reproduces_verified_assets(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temporary:
            root = Path(temporary)
            source = root / "fixture.las"
            write_las(source)
            archive = root / "fixture.7z"
            write_7z(archive, {"las/1_снаружи.las": source.read_bytes(), "las/1_внутри.las": source.read_bytes(), "unrelated.txt": b"not exported"})
            archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
            args = [sys.executable, "-B", str(SPEC.origin), "--archive", str(archive),
                    "--extract-dir", str(root / "extracted"), "--output-dir", str(root / "public-data"),
                    "--evidence-dir", str(root / "evidence"), "--expect-archive-sha256", archive_sha,
                    "--exterior-points", "3", "--interior-points", "4", "--chunk-points", "1"]
            first = subprocess.run(args, text=True, capture_output=True)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            public = root / "public-data"
            manifest = json.loads((public / "manifest.json").read_text())
            self.assertEqual(set(manifest), {"version", "coordinateSystem", "sourcePointCount", "sourceArchiveSha256", "bounds", "interiorBounds", "clouds"})
            self.assertEqual(manifest["sourceArchiveSha256"], archive_sha)
            self.assertEqual(manifest["sourcePointCount"], 8)
            self.assertEqual(manifest["coordinateSystem"], "right-handed-z-up")
            for cloud in manifest["clouds"]:
                content = (public / cloud["file"]).read_bytes()
                self.assertEqual(len(content), cloud["pointCount"] * 16)
                self.assertEqual(len(content), cloud["byteLength"])
                self.assertEqual(hashlib.sha256(content).hexdigest(), cloud["sha256"])
                self.assertEqual(cloud["format"], "xyz-f32-rgb8-stride16")
            before = {p.name: p.read_bytes() for p in public.iterdir()}
            self.assertEqual(set(before), {"manifest.json", "exterior.bin", "interior.bin"})
            self.assertNotIn(str(root), (public / "manifest.json").read_text())
            self.assertEqual(set(p.name for p in (root / "extracted").iterdir()), {"exterior.las", "interior.las"})
            self.assertTrue((root / "evidence" / "overview.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
            second = subprocess.run(args + ["--reuse-extracted"], text=True, capture_output=True)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertEqual(before, {p.name: p.read_bytes() for p in public.iterdir()})
            extracted = root / "extracted" / "interior.las"
            content = bytearray(extracted.read_bytes())
            content[-1] ^= 1
            extracted.write_bytes(content)
            third = subprocess.run(args + ["--reuse-extracted"], text=True, capture_output=True)
            self.assertNotEqual(third.returncode, 0)
            self.assertIn("does not match its verified receipt", third.stderr)
            self.assertEqual(before, {p.name: p.read_bytes() for p in public.iterdir()})
            bad_sha = args.copy()
            bad_sha[bad_sha.index("--expect-archive-sha256") + 1] = "0" * 64
            fourth = subprocess.run(bad_sha, text=True, capture_output=True)
            self.assertNotEqual(fourth.returncode, 0)
            self.assertIn("Archive SHA256 does not match", fourth.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
