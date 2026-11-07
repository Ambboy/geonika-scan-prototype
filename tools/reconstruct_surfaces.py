#!/usr/bin/env python3
"""Local measured LAS -> support-trimmed colored triangle surfaces.

No network, generated textures, proprietary decoder, or mutation of source LAS.
All XYZ stay in the common source frame. glTF's sole root applies Rx(-90deg),
which is inverted by the viewer's Rx(+90deg). COLOR_0 is FLOAT Linear-sRGB.
See --help for the reproducible, bounded-memory CLI and private evidence paths.
"""
from __future__ import annotations
import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import struct
import sys
import time

# Respect an operator's stricter budget, but never use host-wide default threads.
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np
from scipy.spatial import cKDTree
import open3d as o3d
from prepare_scan import LAS_DTYPE, read_las_header, sha256_file, write_json


def scratch_root():
    path = Path(os.environ.get("TMPDIR", str(Path.home() / ".hermes/cache/scratch"))) / "geonika-surfaces-spike"
    path.mkdir(parents=True, exist_ok=True)
    return path


def srgb_to_linear(values):
    a = np.asarray(values, dtype=float)
    return np.where(a <= .04045, a / 12.92, ((a + .055) / 1.055) ** 2.4)


def linear_to_srgb(values):
    a = np.clip(np.asarray(values), 0, 1)
    return np.where(a <= .0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - .055)


def rotate_x(points, radians):
    c, s = np.cos(radians), np.sin(radians)
    return np.asarray(points) @ np.array([[1, 0, 0], [0, c, -s], [0, s, c]]).T


def cloud(points, colors=None):
    out = o3d.geometry.PointCloud()
    out.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=float))
    if colors is not None:
        out.colors = o3d.utility.Vector3dVector(np.asarray(colors, dtype=float))
    return out


def supported_planar_mesh(points, colors, normal, offset, *, grid=.12, max_offset=.04, support=.115):
    """Project measured inliers, then triangulate only locally supported grid cells.

    Not a hull/OBB fill. Every vertex, edge midpoint and centroid must be near
    observed in-plane samples; measured openings wider than 2*support survive.
    A small regularization is bounded by max_offset, not a free design surface.
    """
    points, colors = np.asarray(points), np.asarray(colors)
    n = np.asarray(normal, dtype=float)
    n /= np.linalg.norm(n)
    signed = points @ n + offset
    keep = np.abs(signed) <= max_offset
    p, color = points[keep], colors[keep]
    report = {"inputPoints": len(points), "offPlaneRejected": int((~keep).sum()),
              "grid": grid, "maxOffset": max_offset, "supportRadius": support}
    empty = o3d.geometry.TriangleMesh()
    if len(p) < 3:
        return empty, report
    helper = np.eye(3)[int(np.argmin(np.abs(n)))]
    u = np.cross(helper, n)
    u /= np.linalg.norm(u)
    v = np.cross(n, u)
    base = -offset * n
    uv = np.c_[(p - base) @ u, (p - base) @ v]
    low, high = np.floor(uv.min(0) / grid), np.ceil(uv.max(0) / grid)
    width, height = (high - low).astype(int) + 1
    if width * height > 8_000_000:
        raise ValueError("Plane grid exceeds bounded-memory budget")
    xx, yy = np.meshgrid(np.arange(width), np.arange(height))
    vertices_uv = (np.c_[xx.ravel(), yy.ravel()] + low) * grid
    a = (np.arange(height - 1)[:, None] * width + np.arange(width - 1)).ravel()
    faces = np.r_[np.c_[a, a + 1, a + width + 1], np.c_[a, a + width + 1, a + width]]
    tree = cKDTree(uv)
    vertex_d, nearest = tree.query(vertices_uv, workers=4)
    valid = (vertex_d[faces] <= support).all(1)
    for weights in ((1/3, 1/3, 1/3), (.5, .5, 0), (.5, 0, .5), (0, .5, .5)):
        idx = np.flatnonzero(valid)
        q = np.einsum("ijk,j->ik", vertices_uv[faces[idx]], weights)
        valid[idx] &= tree.query(q, workers=4)[0] <= support
    faces = faces[valid]
    mesh = o3d.geometry.TriangleMesh()
    mesh.vertices = o3d.utility.Vector3dVector(base + vertices_uv[:, :1] * u + vertices_uv[:, 1:] * v)
    mesh.triangles = o3d.utility.Vector3iVector(faces.astype(np.int32))
    mesh.vertex_colors = o3d.utility.Vector3dVector(color[nearest])
    mesh.remove_unreferenced_vertices()
    mesh.compute_vertex_normals()
    report["triangleCount"] = len(mesh.triangles)
    report["regularizationAbsMeters"] = summary(np.abs(signed[keep]))
    return mesh, report


def summary(a):
    a = np.asarray(a)
    if not a.size:
        return {"count": 0, "median": None, "p95": None, "max": None}
    return {"count": int(a.size), "median": float(np.median(a)),
            "p95": float(np.quantile(a, .95)), "max": float(a.max())}


def write_glb(mesh, path, name):
    """Write standalone glTF 2.0 without implicit color-space conversion."""
    mesh.compute_vertex_normals()
    xyz = np.asarray(mesh.vertices, dtype="<f4")
    normals = np.asarray(mesh.vertex_normals, dtype="<f4")
    colors = np.clip(np.asarray(mesh.vertex_colors), 0, 1).astype("<f4")
    indices = np.asarray(mesh.triangles, dtype="<u4").ravel()
    if not (len(xyz) and len(indices) and colors.shape == xyz.shape and np.isfinite(xyz).all()
            and np.isfinite(normals).all() and np.isfinite(colors).all()):
        raise ValueError("A real finite colored triangle mesh is required")
    chunks, views, accessors = [], [], []
    offset = 0
    for array, typ, component, target in ((xyz, "VEC3", 5126, 34962), (normals, "VEC3", 5126, 34962),
                                         (colors, "VEC3", 5126, 34962), (indices, "SCALAR", 5125, 34963)):
        raw = array.tobytes()
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw), "target": target})
        accessor = {"bufferView": len(views)-1, "componentType": component, "count": len(array), "type": typ}
        if len(accessors) == 0:
            accessor.update(min=xyz.min(0).tolist(), max=xyz.max(0).tolist())
        accessors.append(accessor)
        chunks.append(raw)
        offset += len(raw)
    doc = {"asset": {"version": "2.0", "generator": "Measured LAS support-trimmed surfaces"},
           "scene": 0, "scenes": [{"nodes": [0]}],
           "nodes": [{"name": name + "_source_to_Y_up", "rotation": [-2 ** -.5, 0, 0, 2 ** -.5], "mesh": 0}],
           "meshes": [{"name": name, "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
                                                         "indices": 3, "mode": 4, "material": 0}]}],
           "materials": [{"name": "measured_linear_vertex_color", "pbrMetallicRoughness": {
               "baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 1}, "doubleSided": True}],
           "buffers": [{"byteLength": offset}], "bufferViews": views, "accessors": accessors}
    js = json.dumps(doc, separators=(",", ":"), allow_nan=False).encode()
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(chunks)
    binary += b"\x00" * ((-len(binary)) % 4)
    raw = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary))
    raw += struct.pack("<II", len(js), 0x4E4F534A) + js
    raw += struct.pack("<II", len(binary), 0x004E4942) + binary
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)


def read_glb(path):
    raw = Path(path).read_bytes()
    magic, version, size = struct.unpack_from("<III", raw)
    if (magic, version, size) != (0x46546C67, 2, len(raw)):
        raise ValueError("Invalid GLB header")
    js_len, js_kind = struct.unpack_from("<II", raw, 12)
    if js_kind != 0x4E4F534A:
        raise ValueError("Missing GLB JSON")
    doc = json.loads(raw[20:20+js_len])
    bin_len, bin_kind = struct.unpack_from("<II", raw, 20+js_len)
    if bin_kind != 0x004E4942 or 28+js_len+bin_len != size:
        raise ValueError("Invalid standalone binary chunk")
    return doc, raw[28+js_len:]


def glb_accessor(doc, binary, index):
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    dims = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[acc["type"]]
    dtype = {5126: "<f4", 5125: "<u4"}[acc["componentType"]]
    return np.frombuffer(binary, dtype=dtype, count=acc["count"]*dims,
                         offset=view.get("byteOffset", 0)+acc.get("byteOffset", 0)).reshape(-1, dims)


SOURCE_PINS = {
    "exterior": {"points": 49524269, "bytes": 1287631221,
                 "sha256": "8721447de1240ee95fa3ff35a634feebc9ca271cd8515f1647a117607d032ee5"},
    "interior": {"points": 97486182, "bytes": 2534640959,
                 "sha256": "51aa1a2d1a1cde1d59874e74c8a8bfdff21173c343ae089c08736f8595e1b7ab"},
}


def log(event, **values):
    print(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event, **values},
                     ensure_ascii=False, allow_nan=False), flush=True)


def aggregate_las(source, evidence, *, voxel=.065, chunk_points=750_000, expected=None):
    """Every LAS record contributes XYZ and Linear-RGB to its voxel.

    Chunk-local reductions are sharded on disk, then globally reduced one shard
    at a time. Peak memory scales with a chunk and one shard, not source count.
    Counts weight every merge, so scan-order/chunk-size cannot bias centroids.
    """
    source, evidence = Path(source), Path(evidence)
    evidence.mkdir(parents=True, exist_ok=True)
    header = read_las_header(source)
    if expected and (header["pointCount"], header["actualBytes"]) != (expected["points"], expected["bytes"]):
        raise ValueError("Source LAS count/size differs from pinned original")
    cache = evidence / "aggregate.npz"
    receipt_path = evidence / "aggregate.json"
    if cache.exists() and receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if (receipt["voxelMeters"] == voxel and receipt["sourceBytes"] == source.stat().st_size
                and receipt.get("aggregateSha256") and receipt.get("cacheFormat") == "full-las-linear-voxels-v1"):
            sha = sha256_file(source)
            if sha != receipt["sourceSha256"] or (expected and sha != expected["sha256"]):
                raise ValueError("Source pin drift on cache reuse")
            if sha256_file(cache) != receipt["aggregateSha256"]:
                raise ValueError("Aggregate cache integrity mismatch; preserve evidence before rebuilding")
            with np.load(cache) as data:
                xyz, color, weight = data["xyz"], data["linear"], data["counts"]
            if int(weight.sum()) != header["pointCount"] or len(xyz) != receipt["aggregatePointCount"]:
                raise ValueError("Cached full-source point conservation failed")
            log("aggregate-cache-read", points=len(xyz), sourceSha256=sha, cacheSha256=receipt["aggregateSha256"])
            return xyz, color, weight, receipt
    low = np.floor(np.asarray(header["bounds"]["min"]) / voxel).astype(np.int64)
    high = np.floor(np.asarray(header["bounds"]["max"]) / voxel).astype(np.int64)
    dims = high - low + 1
    if int(np.prod(dims, dtype=object)) > np.iinfo(np.int64).max:
        raise ValueError("Voxel grid key overflow")
    partial_dtype = np.dtype([("key", "<i8"), ("count", "<u4"), ("xyz", "<f8", 3), ("color", "<f8", 3)])
    shard_dir = evidence / "voxel-shards"
    shard_dir.mkdir(exist_ok=True)
    shard_paths = [shard_dir / f"{i:02d}.bin" for i in range(32)]
    handles = [p.open("wb") for p in shard_paths]
    lut = srgb_to_linear(np.arange(65536) / 65535)
    digest = hashlib.sha256()
    total, partial_count = 0, 0
    observed_low, observed_high = np.full(3, np.inf), np.full(3, -np.inf)
    start_time = time.monotonic()
    try:
        with source.open("rb") as stream:
            digest.update(stream.read(header["dataOffset"]))
            while total < header["pointCount"]:
                count = min(chunk_points, header["pointCount"] - total)
                block = stream.read(count * 26)
                if len(block) != count * 26:
                    raise ValueError("Truncated source")
                digest.update(block)
                records = np.frombuffer(block, dtype=LAS_DTYPE)
                xyz = records["xyz"].astype(float) * header["scale"] + header["origin"]
                observed_low = np.minimum(observed_low, xyz.min(0))
                observed_high = np.maximum(observed_high, xyz.max(0))
                ijk = np.floor(xyz / voxel).astype(np.int64) - low
                keys = (ijk[:, 0] * dims[1] + ijk[:, 1]) * dims[2] + ijk[:, 2]
                unique, inv, counts = np.unique(keys, return_inverse=True, return_counts=True)
                partial = np.empty(len(unique), dtype=partial_dtype)
                partial["key"], partial["count"] = unique, counts
                for axis in range(3):
                    partial["xyz"][:, axis] = np.bincount(inv, weights=xyz[:, axis], minlength=len(unique))
                    partial["color"][:, axis] = np.bincount(inv, weights=lut[records["rgb"][:, axis]], minlength=len(unique))
                shard = unique % len(handles)
                for i, handle in enumerate(handles):
                    partial[shard == i].tofile(handle)
                total += count
                partial_count += len(partial)
                if total == header["pointCount"] or total % (chunk_points * 8) == 0:
                    log("aggregate-read", source=source.name, read=total, total=header["pointCount"],
                        partialVoxels=partial_count, seconds=round(time.monotonic()-start_time, 2))
    finally:
        for h in handles:
            h.close()
    sha = digest.hexdigest()
    if expected and sha != expected["sha256"]:
        raise ValueError("Source SHA-256 differs from pinned original")
    xyz_parts, rgb_parts, count_parts = [], [], []
    for path in shard_paths:
        partial = np.fromfile(path, dtype=partial_dtype)
        unique, inv = np.unique(partial["key"], return_inverse=True)
        counts = np.bincount(inv, weights=partial["count"], minlength=len(unique)).astype(np.int64)
        xyz = np.stack([np.bincount(inv, weights=partial["xyz"][:, a], minlength=len(unique)) for a in range(3)], 1)
        rgb = np.stack([np.bincount(inv, weights=partial["color"][:, a], minlength=len(unique)) for a in range(3)], 1)
        xyz_parts.append(xyz / counts[:, None])
        rgb_parts.append((rgb / counts[:, None]).astype(np.float32))
        count_parts.append(counts)
        path.unlink()
    shard_dir.rmdir()
    points, linear, counts = np.concatenate(xyz_parts), np.concatenate(rgb_parts), np.concatenate(count_parts)
    if int(counts.sum()) != total:
        raise ValueError("Whole-source voxel count is not conserved")
    np.savez(cache, xyz=points, linear=linear, counts=counts)
    receipt = {"sourceFile": source.name, "sourceSha256": sha, "sourceBytes": header["actualBytes"],
               "sourcePointCount": total, "voxelMeters": voxel, "chunkPoints": chunk_points,
               "aggregatePointCount": len(points), "partialVoxelRecords": partial_count,
               "aggregateSha256": sha256_file(cache), "cacheFormat": "full-las-linear-voxels-v1",
               "observedSourceBounds": {"min": observed_low.tolist(), "max": observed_high.tolist()},
               "aggregation": "all records, weighted XYZ and Linear-sRGB centroid per voxel; 32 disk shards",
               "seconds": time.monotonic()-start_time}
    write_json(receipt_path, receipt)
    log("aggregate-complete", **receipt)
    return points, linear, counts, receipt


def clean_cloud(points, colors, counts, name, evidence):
    receipt = {"aggregatePointCount": len(points), "minSourceRecordsPerVoxel": 4}
    keep = counts >= 4
    receipt["sparseVoxelsRemoved"] = int((~keep).sum())
    receipt["sourceRecordsInSparseVoxels"] = int(counts[~keep].sum())
    pc = cloud(points[keep], colors[keep])
    before = len(pc.points)
    pc, _ = pc.remove_statistical_outlier(nb_neighbors=24, std_ratio=1.8)
    receipt["statisticalOutlierVoxelsRemoved"] = before-len(pc.points)
    xyz = np.asarray(pc.points)
    tree = cKDTree(xyz)
    # A bounded KNN test avoids building the unbounded radius-neighbor graph.
    d = tree.query(xyz, k=[8], workers=4)[0][:, 0]
    dense = d <= .205
    receipt["isolatedVoxelsRemoved"] = int((~dense).sum())
    pc = pc.select_by_index(np.flatnonzero(dense))
    del tree, d, xyz
    # Slightly coarser exterior: vegetation/terrain must not dominate mobile mesh.
    reconstruction_voxel = .085 if name == "exterior" else .065
    before_resample = len(pc.points)
    pc = pc.voxel_down_sample(reconstruction_voxel)
    receipt["resampleMergedVoxelsNotNoise"] = before_resample-len(pc.points)
    receipt["reconstructionVoxelMeters"] = reconstruction_voxel
    receipt["afterDenoiseAndResample"] = len(pc.points)
    search = o3d.geometry.KDTreeSearchParamHybrid(radius=.235, max_nn=40)
    pc.estimate_covariances(search)
    covariance = np.asarray(pc.covariances)
    eig = np.linalg.eigvalsh(covariance)
    curvature = np.maximum(0, eig[:, 0]) / np.maximum(eig.sum(1), 1e-15)
    # Suppress unstructured foliage/reflections, not supported walls/treads.
    threshold = .07 if name == "exterior" else .13
    coherent = curvature <= threshold
    receipt["covarianceCurvatureThreshold"] = threshold
    receipt["unstructuredVoxelsRemoved"] = int((~coherent).sum())
    pc = pc.select_by_index(np.flatnonzero(coherent))
    pc.covariances = o3d.utility.Matrix3dVector([])
    pc.estimate_normals(search)
    log("normal-orientation-start", model=name, points=len(pc.points))
    coarse = pc.voxel_down_sample(.18)
    coarse.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=.40, max_nn=40))
    coarse.orient_normals_consistent_tangent_plane(20, lambda_penalty=5, cos_alpha_tol=.65)
    nearest = cKDTree(np.asarray(coarse.points)).query(np.asarray(pc.points), workers=4)[1]
    normals = np.asarray(pc.normals).copy()
    signs = np.einsum("ij,ij->i", normals, np.asarray(coarse.normals)[nearest])
    normals[signs < 0] *= -1
    pc.normals = o3d.utility.Vector3dVector(normals)
    receipt["normalOrientation"] = "consistent tangent-plane graph at 18cm, nearest sign propagation to dense local normals"
    receipt["orientationAnchorPoints"] = len(coarse.points)
    receipt["cleanedPointCount"] = len(pc.points)
    receipt["cleanedBounds"] = bounds(np.asarray(pc.points))
    o3d.io.write_point_cloud(str(evidence / "cleaned.ply"), pc, write_ascii=False, compressed=False)
    write_json(evidence / "denoise.json", receipt)
    log("denoise-complete", model=name, **receipt)
    return pc, receipt


def bounds(xyz):
    return {"min": np.asarray(xyz).min(0).tolist(), "max": np.asarray(xyz).max(0).tolist()}


def trim_supported(mesh, support_points, *, threshold=.13, max_edge=None):
    """Reject each face unless corners, mid-edges and center have dense support."""
    vertices = np.asarray(mesh.vertices)
    faces = np.asarray(mesh.triangles)
    tree = cKDTree(support_points)
    vertex_d = tree.query(vertices, workers=4)[0]
    keep = (vertex_d[faces] <= threshold).all(1)
    if max_edge is not None:
        for a, b in ((0, 1), (1, 2), (2, 0)):
            keep &= np.linalg.norm(vertices[faces[:, a]] - vertices[faces[:, b]], axis=1) <= max_edge
    for weights in ((1/3, 1/3, 1/3), (.5, .5, 0), (.5, 0, .5), (0, .5, .5)):
        ids = np.flatnonzero(keep)
        for start in range(0, len(ids), 200_000):
            batch = ids[start:start+200_000]
            q = np.einsum("ijk,j->ik", vertices[faces[batch]], weights)
            keep[batch] &= tree.query(q, workers=4)[0] <= threshold
    removed = int((~keep).sum())
    mesh.remove_triangles_by_mask(~keep)
    mesh.remove_unreferenced_vertices()
    return removed


def filter_components(mesh, *, min_area=.12, min_faces=40):
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_unreferenced_vertices()
    labels, counts, areas = mesh.cluster_connected_triangles()
    labels, counts, areas = np.asarray(labels), np.asarray(counts), np.asarray(areas)
    bad = (areas < min_area) | (counts < min_faces)
    remove = bad[labels]
    receipt = {"inputComponents": len(counts), "removedComponents": int(bad.sum()),
               "removedTriangles": int(remove.sum()), "minAreaMeters2": min_area, "minFaces": min_faces,
               "removedAreaMeters2": float(areas[bad].sum())}
    mesh.remove_triangles_by_mask(remove)
    mesh.remove_unreferenced_vertices()
    return receipt


def fit_supported_planes(pc, evidence, name):
    points, colors, normals = np.asarray(pc.points), np.asarray(pc.colors), np.asarray(pc.normals)
    detection = pc.voxel_down_sample(.18)
    planes = o3d.geometry.TriangleMesh()
    labels = np.full(len(points), -1, dtype=np.int32)
    reports = []
    max_planes = 55 if name == "interior" else 40
    o3d.utility.random.seed(20261107)
    for i in range(max_planes):
        if len(detection.points) < 300:
            break
        query = detection
        original_ids = None
        # Alternate unconstrained and vertical-normal priors. Otherwise plentiful
        # ceiling/terrain bands monopolize RANSAC and structural walls are missed.
        if i % 2 == 1:
            vertical_ids = np.flatnonzero(np.abs(np.asarray(detection.normals)[:, 2]) < .20)
            if len(vertical_ids) >= 600:
                query = detection.select_by_index(vertical_ids)
                original_ids = vertical_ids
        model, idx = query.segment_plane(distance_threshold=.035, ransac_n=3, num_iterations=300, probability=.995)
        if original_ids is not None:
            idx = original_ids[np.asarray(idx, dtype=np.int64)]
        if len(idx) < (130 if name == "interior" else 170):
            if original_ids is not None:
                continue
            break
        n, offset = np.asarray(model[:3]), float(model[3])
        n /= np.linalg.norm(n)
        distance = points @ n + offset
        align = np.abs(normals @ n)
        selected = (labels < 0) & (np.abs(distance) <= .045) & (align >= .91)
        ids = np.flatnonzero(selected)
        if len(ids) >= 250:
            # Robust least-squares only within tightly measured, normal-aligned inliers.
            p = points[ids]
            center = np.median(p, axis=0)
            residual = p-center
            eig, vectors = np.linalg.eigh(residual.T @ residual / len(p))
            refined = vectors[:, 0]
            if abs(np.dot(refined, n)) > .998:
                n, offset = refined, -float(np.dot(refined, center))
            residual = points[ids] @ n + offset
            ids = ids[np.abs(residual) <= .04]
            candidate, report = supported_planar_mesh(points[ids], colors[ids], n, offset,
                                                      grid=.12, max_offset=.04, support=.115)
            if len(candidate.triangles):
                component_report = filter_components(candidate, min_area=.24, min_faces=24)
                if len(candidate.triangles) >= 60:
                    planes += candidate
                    labels[ids] = len(reports)
                    report.update(normal=n.tolist(), offset=offset, measuredInliers=len(ids),
                                  components=component_report, triangleCount=len(candidate.triangles))
                    reports.append(report)
                    log("supported-plane", model=name, index=len(reports), points=len(ids),
                        triangles=len(candidate.triangles), normal=np.round(n, 4).tolist(), offset=round(offset, 4))
        detection = detection.select_by_index(idx, invert=True)
    receipt = {"method": "RANSAC + normal-aligned 4cm robust refit; measured occupancy triangle support grid, not hulls",
               "planeCount": len(reports), "assignedPointCount": int((labels >= 0).sum()),
               "gridMeters": .12, "supportRadiusMeters": .115, "maximumProjectionMeters": .04,
               "planes": reports}
    write_json(evidence / "planes.json", receipt)
    o3d.io.write_triangle_mesh(str(evidence / "supported-planes.ply"), planes, write_ascii=False)
    np.save(evidence / "plane-labels.npy", labels)
    return planes, labels, receipt


def transfer_colors(mesh, points, colors):
    # Weighted local Linear-sRGB interpolation, no sRGB-as-linear double gamma.
    tree = cKDTree(points)
    vertices = np.asarray(mesh.vertices)
    result = np.empty_like(vertices)
    for start in range(0, len(vertices), 100_000):
        d, idx = tree.query(vertices[start:start+100_000], k=4, workers=4)
        weights = 1 / np.maximum(d, .012) ** 2
        result[start:start+100_000] = np.einsum("ij,ijk->ik", weights, colors[idx]) / weights.sum(1)[:, None]
    mesh.vertex_colors = o3d.utility.Vector3dVector(np.clip(result, 0, 1))
    mesh.compute_vertex_normals()


def metrics(mesh, dense_points, cleaned_points):
    xyz, faces = np.asarray(mesh.vertices), np.asarray(mesh.triangles)
    triangles = xyz[faces]
    areas = .5 * np.linalg.norm(np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0]), axis=1)
    labels, counts, component_areas = mesh.cluster_connected_triangles()
    tree = cKDTree(dense_points)
    samples = [xyz, triangles.mean(1), (triangles[:, 0]+triangles[:, 1])*.5,
               (triangles[:, 1]+triangles[:, 2])*.5, (triangles[:, 2]+triangles[:, 0])*.5]
    distance = np.concatenate([tree.query(s, workers=4)[0] for s in samples])
    tensor_mesh = o3d.t.geometry.TriangleMesh.from_legacy(mesh)
    scene = o3d.t.geometry.RaycastingScene(nthreads=4)
    scene.add_triangles(tensor_mesh)
    # Spatial voxel order spans all shards; systematic deterministic subset, not source prefix.
    sample_ids = np.linspace(0, len(cleaned_points)-1, min(200_000, len(cleaned_points)), dtype=np.int64)
    point_dist = scene.compute_distance(o3d.core.Tensor(cleaned_points[sample_ids].astype(np.float32)), nthreads=4).numpy()
    return {"vertexCount": len(xyz), "triangleCount": len(faces), "bounds": bounds(xyz),
            "surfaceAreaMeters2": float(areas.sum()), "degenerateTriangles": int((areas <= 1e-10).sum()),
            "connectedComponents": len(counts), "largestComponentsTriangles": sorted(map(int, counts), reverse=True)[:12],
            "meshSamplesToWholeSource65mmVoxelMeters": summary(distance),
            "cleanedPointsToMeshMeters": summary(point_dist),
            "cleanedPointCoverage": {str(threshold): {"count": int((point_dist <= threshold).sum()),
                                                     "fraction": float((point_dist <= threshold).mean())}
                                     for threshold in (.05, .10, .25)},
            "distanceMethod": "all mesh vertices, face centers, 3 edge midpoints -> KDTree of full-LAS voxel centroids; up to 200k cleaned voxels -> exact triangle distance; point-to-mesh denominator includes deliberately removed detached/foliage fragments",
            "normalsFinite": bool(np.isfinite(np.asarray(mesh.vertex_normals)).all()),
            "colorsLinearRGB": True}


def make_previews(mesh, directory, prefix, *, poses=None):
    """True CPU ray/triangle visibility and barycentric color, not cloud splats."""
    from PIL import Image, ImageDraw
    directory.mkdir(parents=True, exist_ok=True)
    scene = o3d.t.geometry.RaycastingScene(nthreads=4)
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(mesh))
    verts, faces = np.asarray(mesh.vertices), np.asarray(mesh.triangles)
    tri = verts[faces]
    face_n = np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0])
    face_n /= np.maximum(np.linalg.norm(face_n, axis=1)[:, None], 1e-12)
    color = np.asarray(mesh.vertex_colors)
    poses = poses or [("overall", [38,-38,24], [10,-1,1.5], 54),
                       ("interior-A", [8,1,1.12], [14,1,1.25], 72),
                       ("interior-C", [15,-4,1.12], [10,0,1.3], 72)]
    width, height = 1280, 800
    outputs = []
    for label, eye, target, fov in poses:
        eye, target = np.asarray(eye, dtype=float), np.asarray(target, dtype=float)
        forward = target-eye
        forward /= np.linalg.norm(forward)
        right = np.cross(forward, [0,0,1])
        right /= np.linalg.norm(right)
        up = np.cross(right, forward)
        xx = ((np.arange(width)+.5)/width*2-1)*math.tan(math.radians(fov/2))*width/height
        yy = (1-(np.arange(height)+.5)/height*2)*math.tan(math.radians(fov/2))
        directions = forward + xx[None, :, None]*right + yy[:, None, None]*up
        rays = np.concatenate([np.broadcast_to(eye, directions.shape), directions], 2).astype(np.float32)
        hit = scene.cast_rays(o3d.core.Tensor(rays), nthreads=4)
        ids = hit["primitive_ids"].numpy()
        mask = ids != np.iinfo(np.uint32).max
        face_ids = ids[mask].astype(np.int64)
        uv = hit["primitive_uvs"].numpy()[mask]
        weights = np.c_[1-uv.sum(1), uv]
        hit_colors = np.einsum("ij,ijk->ik", weights, color[faces[face_ids]])
        light = np.array([-.35, -.5, .8]); light /= np.linalg.norm(light)
        shade = .58 + .42*np.abs(face_n[face_ids] @ light)
        for mode in ("color", "clay"):
            linear = hit_colors if mode == "color" else np.tile([.58,.62,.65], (len(face_ids), 1))
            rgb = np.rint(linear_to_srgb(linear*shade[:, None])*255).astype(np.uint8)
            canvas = np.empty((height, width, 3), dtype=np.uint8)
            canvas[:] = [12,18,26]
            canvas[mask] = rgb
            image = Image.fromarray(canvas)
            draw = ImageDraw.Draw(image)
            draw.rectangle([0,0,width,33], fill=(10,15,22))
            draw.text((14,10), f"{prefix} / {label} / {mode} / {len(faces):,} REAL TRIANGLES / CPU raycast", fill=(235,235,235))
            filename = directory / f"{prefix}-{label}-{mode}.png"
            image.save(filename)
            outputs.append(str(filename))
    return outputs


def regularize_mesh_vertices(mesh, measured_points, labels, plane_reports):
    """Flatten only identified measured inliers; preserve BPA edge topology.

    Replacing faces by nearest plane-center tests tears door/floor seams. Moving
    tightly supported vertices keeps those measured cross-boundary faces intact.
    """
    xyz = np.asarray(mesh.vertices).copy()
    nearest = cKDTree(measured_points).query(xyz, workers=4)[1]
    vertex_labels = labels[nearest]
    shifts = []
    for i, report in enumerate(plane_reports):
        ids = np.flatnonzero(vertex_labels == i)
        n = np.asarray(report["normal"])
        distance = xyz[ids] @ n + report["offset"]
        valid = np.abs(distance) <= .040001
        ids, distance = ids[valid], distance[valid]
        xyz[ids] -= distance[:, None]*n
        shifts.append(np.abs(distance))
    mesh.vertices = o3d.utility.Vector3dVector(xyz)
    mesh.remove_degenerate_triangles()
    mesh.compute_vertex_normals()
    return summary(np.concatenate(shifts) if shifts else [])


def remove_detached_fragments(mesh, *, anchor_area=8., max_gap=.28):
    """Keep the principal measured surface and its local component-gap graph.

    Area alone is not an anchor: large detached reflection panels also exist in
    this LAS. Grow from the largest-area component through <=28cm mesh-vertex
    gaps. This preserves nearby measured stairs/walls/roof patches, but removes
    unsupported spatial islands (including unrelated disconnected surroundings).
    Run before decimation, while anchor boundary vertices remain dense.
    """
    labels, counts, areas = mesh.cluster_connected_triangles()
    labels, areas = np.asarray(labels), np.asarray(areas)
    faces, xyz = np.asarray(mesh.triangles), np.asarray(mesh.vertices)
    if not len(areas) or areas.max() < anchor_area:
        return {"removedComponents": 0, "removedTriangles": 0}
    retained = np.zeros(len(areas), dtype=bool)
    retained[int(np.argmax(areas))] = True
    min_gap = np.full(len(areas), np.inf)
    iterations = 0
    while iterations < len(areas):
        iterations += 1
        anchor_vertices = np.unique(faces[retained[labels]])
        tree = cKDTree(xyz[anchor_vertices])
        vertex_gap = tree.query(xyz, workers=4)[0]
        face_gap = vertex_gap[faces].min(1)
        min_gap = np.full(len(areas), np.inf)
        np.minimum.at(min_gap, labels, face_gap)
        grown = retained | (min_gap <= max_gap)
        if np.array_equal(grown, retained):
            break
        retained = grown
    bad = ~retained
    remove = bad[labels]
    receipt = {"removedComponents": int(bad.sum()), "removedTriangles": int(remove.sum()),
               "removedAreaMeters2": float(areas[bad].sum()), "minimumPrincipalAreaMeters2": anchor_area,
               "anchorMode": "largest-area measured component, iterated local proximity graph",
               "maximumGapMeters": max_gap, "graphIterations": iterations,
               "removedComponentGapsMeters": min_gap[bad].tolist()}
    mesh.remove_triangles_by_mask(remove)
    mesh.remove_unreferenced_vertices()
    return receipt


def reconstruct_one(name, points, linear, counts, aggregate_receipt, evidence, output, *, compare=True):
    start_time = time.monotonic()
    pc, denoise = clean_cloud(points, linear, counts, name, evidence)
    # Whole-source aggregation before denoise is the independent geometric support reference.
    dense_points = points[counts >= 4]
    dense_colors = linear[counts >= 4]
    del points, linear, counts
    gc.collect()
    log("bpa-start", model=name, points=len(pc.points))
    radii = [.095, .155, .23] if name == "exterior" else [.075, .12, .18]
    bpa = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(pc, o3d.utility.DoubleVector(radii))
    raw_bpa_faces = len(bpa.triangles)
    bpa_trim = trim_supported(bpa, dense_points, threshold=.12, max_edge=.40 if name == "exterior" else .32)
    bpa_components = filter_components(bpa, min_area=.18 if name == "exterior" else .10, min_faces=35)
    log("bpa-complete", model=name, rawTriangles=raw_bpa_faces, unsupportedRemoved=bpa_trim, retainedTriangles=len(bpa.triangles))
    target = 105_000 if name == "exterior" else 150_000
    if compare:
        baseline = bpa.simplify_quadric_decimation(target, maximum_error=.003, boundary_weight=5)
        baseline.remove_unreferenced_vertices()
        baseline_trim = trim_supported(baseline, dense_points, threshold=.135)
        transfer_colors(baseline, dense_points, dense_colors)
        write_glb(baseline, evidence / "candidate-1-bpa.glb", name)
        report = metrics(baseline, dense_points, np.asarray(pc.points))
        report.update(method="denoised oriented BPA, support/component trim, bounded QEM", unsupportedTrianglesRemoved=bpa_trim+baseline_trim,
                      componentRemoval=bpa_components, byteLength=(evidence / "candidate-1-bpa.glb").stat().st_size,
                      sha256=sha256_file(evidence / "candidate-1-bpa.glb"))
        write_json(evidence / "candidate-1-bpa.json", report)
        make_previews(baseline, evidence / "previews", "candidate-1-bpa",
                      poses=[("overall", [38,-38,24], [10,-1,1.5],54)] if name == "exterior" else None)
        del baseline
        gc.collect()
    planes, labels, plane_receipt = fit_supported_planes(pc, evidence, name)
    regularization = regularize_mesh_vertices(bpa, np.asarray(pc.points), labels, plane_receipt["planes"])
    # Keep measured BPA seams intact. Occupancy-grid plane triangles only fill
    # locally measured holes not already covered by the regularized BPA mesh.
    # This does not fill OBB/convex hulls or measured doors/windows.
    verts, faces = np.asarray(planes.vertices), np.asarray(planes.triangles)
    centers = verts[faces].mean(1)
    bpa_scene = o3d.t.geometry.RaycastingScene(nthreads=4)
    bpa_scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(bpa))
    center_distance = bpa_scene.compute_distance(o3d.core.Tensor(centers.astype(np.float32)), nthreads=4).numpy()
    plane_overlap = center_distance < .045
    planes.remove_triangles_by_mask(plane_overlap)
    planes.remove_unreferenced_vertices()
    added_plane_triangles = len(planes.triangles)
    residual_triangles = len(bpa.triangles)
    hybrid = bpa + planes
    del planes, bpa, bpa_scene
    hybrid.remove_degenerate_triangles()
    hybrid.remove_duplicated_triangles()
    hybrid.remove_duplicated_vertices()
    hybrid.remove_unreferenced_vertices()
    detached = remove_detached_fragments(hybrid, anchor_area=8., max_gap=.28)
    pre_simplify = len(hybrid.triangles)
    log("hybrid-simplification-start", model=name, triangles=pre_simplify, target=target)
    hybrid = hybrid.simplify_quadric_decimation(target, maximum_error=.0025, boundary_weight=8)
    final_trim = trim_supported(hybrid, dense_points, threshold=.135)
    # Decimation changes component face counts: filter by physical area, not an arbitrary high face count.
    final_components = filter_components(hybrid, min_area=.12 if name == "exterior" else .075, min_faces=3)
    # Measure the actual float32 geometry that is exported, including collapse cleanup.
    hybrid.vertices = o3d.utility.Vector3dVector(np.asarray(hybrid.vertices).astype(np.float32).astype(float))
    h_xyz, h_faces = np.asarray(hybrid.vertices), np.asarray(hybrid.triangles)
    h_tri = h_xyz[h_faces]
    collapsed = np.linalg.norm(np.cross(h_tri[:,1]-h_tri[:,0], h_tri[:,2]-h_tri[:,0]), axis=1) <= 2e-10
    hybrid.remove_triangles_by_mask(collapsed)
    hybrid.remove_unreferenced_vertices()
    transfer_colors(hybrid, dense_points, dense_colors)
    final_metrics = metrics(hybrid, dense_points, np.asarray(pc.points))
    method = "full-LAS weighted 65mm voxels; sparse/statistical/KNN/covariance denoise; oriented BPA + 4cm supported plane occupancy regularization; dense-source support/component trim; bounded QEM; measured Linear-sRGB"
    final_metrics.update(id=name, method=method, sourcePointCount=aggregate_receipt["sourcePointCount"],
                         sourceSha256=aggregate_receipt["sourceSha256"], sourceBytes=aggregate_receipt["sourceBytes"],
                         denoise=denoise, planeCount=plane_receipt["planeCount"],
                         planeAssignedPoints=plane_receipt["assignedPointCount"],
                         bpaRawTriangles=raw_bpa_faces, bpaUnsupportedRemoved=bpa_trim,
                         duplicatePlaneTrianglesNotAdded=int(plane_overlap.sum()),
                         regularizedBpaVertexMovementMeters=regularization, holePlaneTrianglesAdded=added_plane_triangles,
                         regularizedBpaTriangles=residual_triangles, detachedFragmentRemoval=detached,
                         float32CollapsedTrianglesRemoved=int(collapsed.sum()), bpaComponentRemoval=bpa_components,
                         hybridTrianglesBeforeSimplification=pre_simplify, finalUnsupportedTrianglesRemoved=final_trim,
                         finalComponentRemoval=final_components, seconds=time.monotonic()-start_time,
                         peakRssMiB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024)
    candidate = evidence / "candidate-2-supported-hybrid.glb"
    write_glb(hybrid, candidate, name)
    final_metrics.update(byteLength=candidate.stat().st_size, sha256=sha256_file(candidate))
    write_json(evidence / "candidate-2-supported-hybrid.json", final_metrics)
    preview_paths = make_previews(hybrid, evidence / "previews", "candidate-2-supported-hybrid",
                                  poses=[("overall", [38,-38,24], [10,-1,1.5],54)] if name == "exterior" else None)
    final_metrics["previewPaths"] = preview_paths
    write_json(evidence / "candidate-2-supported-hybrid.json", final_metrics)
    # Finalize is a separate explicit stage after visual review. Never publish a placeholder.
    log("candidate-complete", model=name, candidate=str(candidate), triangles=len(hybrid.triangles),
        byteLength=candidate.stat().st_size, seconds=round(time.monotonic()-start_time, 2),
        peakRssMiB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024)
    return final_metrics


def finalize(evidence, output):
    models = []
    preview_mesh = o3d.geometry.TriangleMesh()
    for name in ("exterior", "interior"):
        private = evidence / name
        candidate = private / "candidate-2-supported-hybrid.glb"
        report = json.loads((private / "candidate-2-supported-hybrid.json").read_text())
        if sha256_file(candidate) != report["sha256"]:
            raise ValueError("Candidate/metrics hash mismatch")
        doc, binary = read_glb(candidate)
        primitive = doc["meshes"][0]["primitives"][0]
        xyz = glb_accessor(doc, binary, primitive["attributes"]["POSITION"])
        normals = glb_accessor(doc, binary, primitive["attributes"]["NORMAL"])
        colors = glb_accessor(doc, binary, primitive["attributes"]["COLOR_0"])
        idx = glb_accessor(doc, binary, primitive["indices"])
        if not (len(xyz) == report["vertexCount"] and len(idx) == report["triangleCount"]*3
                and np.isfinite(xyz).all() and np.isfinite(normals).all() and np.isfinite(colors).all()
                and doc["nodes"][0]["rotation"] == [-2**-.5,0,0,2**-.5]
                and "uri" not in doc["buffers"][0]):
            raise ValueError("Final GLB contract failed")
        output.mkdir(parents=True, exist_ok=True)
        destination = output / (name + ".glb")
        destination.write_bytes(candidate.read_bytes())
        model = {k: report[k] for k in ("id", "byteLength", "sha256", "vertexCount", "triangleCount", "sourcePointCount", "method")}
        model.update(file=destination.name, bounds=bounds(xyz), sourceSha256=report["sourceSha256"],
                     metrics={k: report[k] for k in ("planeCount", "degenerateTriangles", "connectedComponents",
                                                       "meshSamplesToWholeSource65mmVoxelMeters", "cleanedPointsToMeshMeters")})
        models.append(model)
        decoded = o3d.geometry.TriangleMesh()
        decoded.vertices = o3d.utility.Vector3dVector(xyz.astype(float))
        decoded.triangles = o3d.utility.Vector3iVector(idx.reshape(-1, 3).astype(np.int32))
        decoded.vertex_colors = o3d.utility.Vector3dVector(colors.astype(float))
        decoded.vertex_normals = o3d.utility.Vector3dVector(normals.astype(float))
        preview_mesh += decoded
    overall = {"min": np.min([m["bounds"]["min"] for m in models], axis=0).tolist(),
               "max": np.max([m["bounds"]["max"] for m in models], axis=0).tolist()}
    manifest = {"version": 1, "coordinateSystem": "right-handed-z-up", "assetUpAxis": "Y",
                "assetToSourceRotation": "x+90deg", "sourcePointCount": sum(m["sourcePointCount"] for m in models),
                "bounds": overall, "interiorBounds": models[1]["bounds"], "models": models,
                "colorEncoding": "FLOAT VEC3 COLOR_0, Linear-sRGB from source uint16 / 65535, no textures",
                "limitations": ["No inferred invisible geometry; unmeasured regions remain open.",
                                "Planar inliers may move up to 4cm; support grid only closes sub-23cm gaps.",
                                "Not BIM or watertight; sparse vegetation, reflections and disconnected tiny fragments removed."]}
    write_json(output / "surfaces.json", manifest)
    preview_paths = make_previews(preview_mesh, evidence / "previews-final", "final-exported-assets")
    write_json(evidence / "final-preview-receipt.json", {"assets": models, "previews": preview_paths,
                    "renderMethod": "CPU raycasts against actual exported triangle buffers, barycentric measured Linear-sRGB; no points/splats"})
    log("finalized", triangles=sum(m["triangleCount"] for m in models),
        byteLength=sum(m["byteLength"] for m in models), metadata=str(output / "surfaces.json"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("public/data"))
    parser.add_argument("--model", choices=["interior", "exterior", "both"], default="both")
    parser.add_argument("--stage", choices=["aggregate", "reconstruct", "finalize"], default="reconstruct")
    parser.add_argument("--voxel", type=float, default=.065)
    parser.add_argument("--chunk-points", type=int, default=750_000)
    parser.add_argument("--skip-baseline", action="store_true", help="Retain an already measured candidate 1; regenerate candidate 2 only")
    args = parser.parse_args()
    log("run-start", argv=sys.argv, generatorSha256=sha256_file(Path(__file__)),
        numpyVersion=np.__version__, open3dVersion=o3d.__version__,
        ompThreads=os.environ.get("OMP_NUM_THREADS"), blasThreads=os.environ.get("OPENBLAS_NUM_THREADS"))
    if args.voxel <= 0 or not 1 <= args.chunk_points <= 2_000_000:
        parser.error("voxel must be positive; chunk-points must be 1..2000000")
    if args.stage == "finalize":
        finalize(args.evidence_dir, args.output_dir)
        return
    for name in (["exterior", "interior"] if args.model == "both" else [args.model]):
        points, linear, counts, receipt = aggregate_las(args.source_dir / (name + ".las"), args.evidence_dir / name,
                      voxel=args.voxel, chunk_points=args.chunk_points, expected=SOURCE_PINS[name])
        if args.stage == "reconstruct":
            reconstruct_one(name, points, linear, counts, receipt, args.evidence_dir / name,
                            args.output_dir, compare=not args.skip_baseline)
        del points, linear, counts
        gc.collect()
    log("cli-complete", peakRssMiB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024)


if __name__ == "__main__":
    main()
