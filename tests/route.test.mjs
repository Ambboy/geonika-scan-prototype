import test from 'node:test';
import assert from 'node:assert/strict';

let createRoute = () => ({ chapters: [] });
let sampleRoute = () => ({ position: [0, 0, 0] });
try {
  ({ createRoute, sampleRoute } = await import('../src/route.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('/src/route.mjs')) throw error;
}

const bounds = { min: [-29.997999998909044, -33.99599994170666, -13.390999082538482], max: [43.3649989634933, 25.32199894440174, 16.585000272777677] };
const interiorBounds = { min: [2.7337548859715, -12.960410910313911, -1.3738530427087121], max: [19.43576412577449, 7.786501731647591, 8.36014716328482] };
const route = createRoute(bounds, interiorBounds);

test('public route takes real bounds, starts outside and leads into the interior without axis changes', () => {
  assert.equal(route.chapters.length, 5, 'the measured scan needs five actual camera chapters');
  const exterior = sampleRoute(route, 0);
  const inside = sampleRoute(route, 0.5);
  assert.ok(exterior.position[1] < interiorBounds.min[1]);
  inside.position.forEach((value, axis) => assert.ok(value > interiorBounds.min[axis] && value < interiorBounds.max[axis]));
  assert.equal(exterior.exterior, 1);
  assert.equal(inside.interior, 1);
  assert.equal(inside.exterior, 0);
  assert.equal(sampleRoute(route, 0.76).sliceEnabled, true, 'section must cut actual interior points');
});

test('route is reversible and continuous at every real chapter, including section height and cloud weights', () => {
  const forward = Array.from({ length: 101 }, (_, i) => sampleRoute(route, i / 100));
  for (let i = 100; i >= 0; i--) assert.deepEqual(sampleRoute(route, i / 100), forward[i]);
  route.chapters.slice(1, -1).forEach(chapter => {
    const before = sampleRoute(route, chapter.progress - 1e-7);
    const after = sampleRoute(route, chapter.progress + 1e-7);
    before.position.forEach((v, axis) => assert.ok(Math.abs(v - after.position[axis]) < 0.001));
    assert.ok(Math.abs(before.sliceHeight - after.sliceHeight) < 0.001);
    assert.ok(Math.abs(before.interior - after.interior) < 0.001);
  });
  assert.deepEqual(sampleRoute(route, -4), sampleRoute(route, 0));
  assert.deepEqual(sampleRoute(route, 4), sampleRoute(route, 1));
});

test('route framing actually depends on supplied measured bounds', () => {
  const shift = bounds => ({ min: bounds.min.map(value => value + 100), max: bounds.max.map(value => value + 100) });
  const shifted = createRoute(shift(bounds), shift(interiorBounds));
  for (const progress of [0, 0.24, 0.5, 0.76, 1]) {
    const original = sampleRoute(route, progress);
    const moved = sampleRoute(shifted, progress);
    original.position.forEach((v, axis) => assert.ok(Math.abs(moved.position[axis] - v - 100) < 1e-9));
    original.target.forEach((v, axis) => assert.ok(Math.abs(moved.target[axis] - v - 100) < 1e-9));
  }
});

test('inside chapter frames measured room depth rather than a nearby blank wall', async () => {
  const THREE = await import('three');
  const { readFile } = await import('node:fs/promises');
  const { parseSurface, disposeSurface } = await import('../src/surfaces.mjs');
  const manifest = JSON.parse(await readFile(new URL('../public/data/surfaces.json', import.meta.url), 'utf8'));
  const model = manifest.models.find(item => item.id === 'interior');
  const raw = await readFile(new URL('../public/data/interior.glb', import.meta.url));
  const { group } = await parseSurface(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), model);
  try {
    const pose = sampleRoute(createRoute(manifest.bounds, manifest.interiorBounds), 0.5);
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.03, 1500);
    camera.up.set(0, 0, 1);
    camera.position.fromArray(pose.position);
    camera.lookAt(new THREE.Vector3(...pose.target));
    camera.updateMatrixWorld(true);
    const depths = [];
    for (const x of [-0.4, 0, 0.4]) for (const y of [-0.4, 0, 0.4]) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(x, y), camera);
      depths.push(ray.intersectObject(group, true)[0]?.distance ?? null);
    }
    // A measured framing guard, not a substitute for inspecting browser pixels.
    // Ignore holes/no-hit rays: empty space alone cannot satisfy the check.
    assert.ok(depths.filter(value => Number.isFinite(value) && value >= 3).length >= 6,
      `The interior must show room depth in at least 6/9 central rays; actual: ${JSON.stringify(depths)}`);
  } finally { disposeSurface(group); }
});

