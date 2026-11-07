"""Behavioral geometry/export regression; runs without any private LAS fixture."""
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
try:
    import reconstruct_surfaces as surfaces
except ModuleNotFoundError as exc:
    if exc.name != "reconstruct_surfaces":
        raise
    surfaces = None


class SurfaceBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(surfaces, "Missing measured plane reconstruction/export behavior")

    def test_supported_plane_denoises_without_capping_measured_door(self):
        rng = np.random.default_rng(7)
        x, y = np.meshgrid(np.arange(0, 5.001, .045), np.arange(0, 4.001, .045))
        xy = np.c_[x.ravel(), y.ravel()]
        # A 1.4m x 2.2m measured opening; do not cap its convex hull.
        xy = xy[~((xy[:, 0] > 1.8) & (xy[:, 0] < 3.2) & (xy[:, 1] < 2.2))]
        points = np.c_[xy, rng.normal(0, .009, len(xy))]
        points = np.r_[points, np.c_[rng.uniform(0, 5, 200), rng.uniform(0, 4, 200), rng.uniform(.2, 2, 200)]]
        colors = np.tile([.25, .45, .65], (len(points), 1))
        mesh, report = surfaces.supported_planar_mesh(points, colors, [0, 0, 1], 0.0,
                                                      grid=.10, max_offset=.035, support=.09)
        self.assertGreater(len(mesh.triangles), 1500, "Must reconstruct a continuous measured wall, not an empty refusal")
        vertices = np.asarray(mesh.vertices)
        faces = np.asarray(mesh.triangles)
        self.assertLess(np.max(np.abs(vertices[:, 2])), 1e-8)
        self.assertGreaterEqual(report["offPlaneRejected"], 200)
        # Check multiple barycentric samples, not just triangle centroids.
        tri = vertices[faces]
        samples = np.concatenate([tri.mean(1), tri[:, 0] * .6 + tri[:, 1] * .2 + tri[:, 2] * .2,
                                  tri[:, 1] * .6 + tri[:, 0] * .2 + tri[:, 2] * .2])
        door = (samples[:, 0] > 1.95) & (samples[:, 0] < 3.05) & (samples[:, 1] < 2.05)
        self.assertFalse(np.any(door), "Unsupported measured doorway was capped")
        area = .5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1).sum()
        self.assertGreater(area, 15.0)
        self.assertLess(area, 18.0)
        self.assertTrue(np.allclose(np.asarray(mesh.vertex_colors), colors[0]))

    def test_whole_las_voxel_means_are_chunk_invariant_and_linear(self):
        # Complete miniature PDRF2 acquisition, arranged to cross every chunk.
        records = np.zeros(257, dtype=surfaces.LAS_DTYPE)
        records["xyz"][:, 0] = np.arange(257) % 17
        records["xyz"][:, 1] = np.arange(257) % 7
        records["xyz"][:, 2] = np.arange(257) % 3
        records["rgb"][:] = 128 * 257
        records["rgb"][::2, 0] = 0
        xyz = records["xyz"].astype(float) * .01
        header = bytearray(227)
        header[:4], header[24:26] = b"LASF", b"\x01\x02"
        struct.pack_into("<HI", header, 94, 227, 227)
        struct.pack_into("<BHI", header, 104, 2, 26, len(records))
        struct.pack_into("<3d", header, 131, .01, .01, .01)
        struct.pack_into("<3d", header, 155, 0, 0, 0)
        struct.pack_into("<6d", header, 179, xyz[:,0].max(), xyz[:,0].min(), xyz[:,1].max(), xyz[:,1].min(), xyz[:,2].max(), xyz[:,2].min())
        with tempfile.TemporaryDirectory(dir=surfaces.scratch_root()) as directory:
            root = Path(directory)
            source = root / "fixture.las"
            source.write_bytes(header + records.tobytes())
            a = surfaces.aggregate_las(source, root / "a", voxel=.10, chunk_points=17)
            b = surfaces.aggregate_las(source, root / "b", voxel=.10, chunk_points=91)
        self.assertEqual(int(a[2].sum()), 257)
        self.assertEqual(a[3]["sourcePointCount"], 257)
        self.assertTrue(np.allclose(a[0], b[0], atol=1e-12))
        self.assertTrue(np.allclose(a[1], b[1], atol=1e-7))
        self.assertTrue(np.array_equal(a[2], b[2]))
        self.assertTrue(np.allclose(np.average(a[0], axis=0, weights=a[2]), xyz.mean(0)))
        expected = surfaces.srgb_to_linear(records["rgb"] / 65535).mean(0)
        self.assertTrue(np.allclose(np.average(a[1], axis=0, weights=a[2]), expected, atol=1e-7))
        self.assertEqual(a[3]["sourceSha256"], b[3]["sourceSha256"])

    def test_support_trim_rejects_a_triangle_bridging_a_large_opening(self):
        import open3d as o3d
        mesh = o3d.geometry.TriangleMesh()
        mesh.vertices = o3d.utility.Vector3dVector([[0,0,0], [2,0,0], [1,2,0]])
        mesh.triangles = o3d.utility.Vector3iVector([[0,1,2]])
        removed = surfaces.trim_supported(mesh, np.asarray(mesh.vertices).copy(), threshold=.1)
        self.assertEqual(removed, 1)
        self.assertEqual(len(mesh.triangles), 0)

    def test_public_assets_match_manifest_and_original_frame(self):
        import hashlib
        public = ROOT / "public/data"
        manifest_path = public / "surfaces.json"
        self.assertTrue(manifest_path.exists(), "Both measured GLBs and final metadata must actually be delivered")
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest["coordinateSystem"], "right-handed-z-up")
        self.assertEqual(manifest["assetToSourceRotation"], "x+90deg")
        self.assertEqual(manifest["assetUpAxis"], "Y")
        self.assertEqual(manifest["sourcePointCount"], 147010451)
        self.assertEqual({m["id"] for m in manifest["models"]}, {"interior", "exterior"})
        for model in manifest["models"]:
            path = public / model["file"]
            raw = path.read_bytes()
            self.assertEqual(len(raw), model["byteLength"])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), model["sha256"])
            doc, binary = surfaces.read_glb(path)
            self.assertEqual(doc["nodes"][0]["rotation"], [-2**-.5,0,0,2**-.5])
            self.assertEqual(len(doc["buffers"]), 1)
            self.assertNotIn("uri", doc["buffers"][0])
            self.assertNotIn("extensionsRequired", doc)
            primitive = doc["meshes"][0]["primitives"][0]
            xyz = surfaces.glb_accessor(doc, binary, primitive["attributes"]["POSITION"])
            normals = surfaces.glb_accessor(doc, binary, primitive["attributes"]["NORMAL"])
            colors = surfaces.glb_accessor(doc, binary, primitive["attributes"]["COLOR_0"])
            idx = surfaces.glb_accessor(doc, binary, primitive["indices"]).ravel()
            self.assertEqual(len(xyz), model["vertexCount"])
            self.assertEqual(len(idx), model["triangleCount"]*3)
            self.assertGreater(model["triangleCount"], 10000)
            self.assertLess(int(idx.max()), len(xyz))
            self.assertTrue(np.isfinite(xyz).all() and np.isfinite(normals).all() and np.isfinite(colors).all())
            self.assertTrue(np.allclose(np.linalg.norm(normals, axis=1), 1, atol=2e-5))
            self.assertTrue((colors >= 0).all() and (colors <= 1).all())
            self.assertGreater(float(colors.std()), .02, "Do not replace measured color with one clay material")
            self.assertTrue(np.allclose(xyz.min(0), model["bounds"]["min"], atol=1e-6))
            self.assertTrue(np.allclose(xyz.max(0), model["bounds"]["max"], atol=1e-6))
            self.assertTrue(np.allclose(surfaces.rotate_x(surfaces.rotate_x(xyz, -np.pi/2), np.pi/2), xyz))
            tri = xyz[idx.reshape(-1, 3)].astype(float)
            areas = np.linalg.norm(np.cross(tri[:,1]-tri[:,0], tri[:,2]-tri[:,0]), axis=1)
            self.assertFalse(np.any(areas <= 1e-10), "Export must not introduce degenerate faces")

    def test_detached_large_floating_panel_is_not_a_structural_anchor(self):
        import open3d as o3d
        mesh = o3d.geometry.TriangleMesh()
        # 16m² principal floor; nearby measured vertical panel; detached 9m² ghost.
        vertices = np.array([[0,0,0],[4,0,0],[4,4,0],[0,4,0],
                             [4.15,0,0],[4.15,0,1],[4.15,1,1],[4.15,1,0],
                             [0,0,10],[3,0,10],[3,3,10],[0,3,10]], dtype=float)
        mesh.vertices = o3d.utility.Vector3dVector(vertices)
        mesh.triangles = o3d.utility.Vector3iVector([[0,1,2],[0,2,3],[4,5,6],[4,6,7],[8,9,10],[8,10,11]])
        report = surfaces.remove_detached_fragments(mesh, max_gap=.28)
        self.assertEqual(report["removedTriangles"], 2, "A large detached reflection is not an anchor merely because it has area")
        self.assertEqual(len(mesh.triangles), 4, "Nearby real vertical surfaces must survive")
        self.assertLess(np.asarray(mesh.vertices)[:, 2].max(), 2)

    def test_glb_standalone_linear_color_normals_and_reversible_axes(self):
        import open3d as o3d
        mesh = o3d.geometry.TriangleMesh()
        xyz = np.array([[2, 3, 4], [3, 3, 4], [2, 4, 4]], dtype=float)
        mesh.vertices = o3d.utility.Vector3dVector(xyz)
        mesh.triangles = o3d.utility.Vector3iVector([[0, 1, 2]])
        linear = surfaces.srgb_to_linear(np.full((3, 3), 128 / 255))
        mesh.vertex_colors = o3d.utility.Vector3dVector(linear)
        mesh.compute_vertex_normals()
        with tempfile.TemporaryDirectory(dir=surfaces.scratch_root()) as directory:
            path = Path(directory) / "surface.glb"
            surfaces.write_glb(mesh, path, "fixture")
            doc, binary = surfaces.read_glb(path)
        self.assertEqual(doc["asset"]["version"], "2.0")
        self.assertNotIn("uri", doc["buffers"][0])
        self.assertNotIn("extensionsRequired", doc)
        self.assertEqual(doc["nodes"][0]["rotation"], [-2 ** -.5, 0, 0, 2 ** -.5])
        primitive = doc["meshes"][0]["primitives"][0]
        self.assertEqual(primitive["mode"], 4)
        self.assertEqual(set(primitive["attributes"]), {"POSITION", "NORMAL", "COLOR_0"})
        decoded = {name: surfaces.glb_accessor(doc, binary, idx) for name, idx in primitive["attributes"].items()}
        self.assertTrue(np.allclose(decoded["POSITION"], xyz))
        self.assertTrue(np.allclose(decoded["NORMAL"], [0, 0, 1]))
        self.assertTrue(np.allclose(decoded["COLOR_0"], .2158605, atol=1e-6))
        # Source vertices remain exact under root(-90) + frontend parent(+90).
        gltf = surfaces.rotate_x(decoded["POSITION"], -np.pi / 2)
        self.assertTrue(np.allclose(gltf[:, 1], xyz[:, 2]))
        self.assertTrue(np.allclose(surfaces.rotate_x(gltf, np.pi / 2), xyz))
        material = doc["materials"][0]
        self.assertEqual(material["pbrMetallicRoughness"]["metallicFactor"], 0)
        self.assertEqual(material["pbrMetallicRoughness"]["roughnessFactor"], 1)
        self.assertTrue(material["doubleSided"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
