import test from 'node:test';
import assert from 'node:assert/strict';

// A missing public module is caught narrowly so RED is an absent behavior,
// not a module-resolution crash. All other import failures remain fatal.
let decodeCloud = () => ({ pointCount: 0, positions: [], colors: [] });
let validateManifest;
try {
  ({ decodeCloud, validateManifest } = await import('../src/cloud.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('/src/cloud.mjs')) throw error;
}

function fixture(points) {
  const buffer = new ArrayBuffer(points.length * 16);
  const view = new DataView(buffer);
  points.forEach(([x, y, z, r, g, b], i) => {
    const offset = i * 16;
    [x, y, z].forEach((value, axis) => view.setFloat32(offset + axis * 4, value, true));
    [r, g, b, 255].forEach((value, channel) => view.setUint8(offset + 12 + channel, value));
  });
  return buffer;
}

const cloud = {
  id: 'interior', file: 'interior.bin', format: 'xyz-f32-rgb8-stride16',
  pointCount: 2, byteLength: 32, sourcePointCount: 97486182,
  sha256: 'a'.repeat(64), label: 'Внутри',
  bounds: { min: [2, -13, -2], max: [20, 8, 9] },
};

test('public decoder renders measured XYZ in unchanged right-handed Z-up and linearizes sRGB', () => {
  const decoded = decodeCloud(fixture([[3, -12, -1, 128, 0, 255], [19, 7, 8, 255, 128, 0]]), cloud);
  assert.equal(decoded.pointCount, 2, 'both real records must survive decoding');
  assert.deepEqual(Array.from(decoded.positions), [3, -12, -1, 19, 7, 8]);
  assert.ok(Math.abs(decoded.colors[0] - 0.2158605) < 1e-6, '128 sRGB must not be treated as linear 0.502');
  assert.equal(decoded.colors[1], 0);
  assert.equal(decoded.colors[2], 1);
});

test('decoder refuses truncated, oversized, nonfinite and corrupt records', () => {
  assert.throws(() => decodeCloud(new ArrayBuffer(16), cloud), /Неполный/);
  assert.throws(() => decodeCloud(new ArrayBuffer(48), cloud), /Неполный/);
  assert.throws(() => decodeCloud(fixture([[NaN, 0, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0]]), cloud), /Нечисловая/);
  assert.throws(() => decodeCloud(fixture([[99, 0, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0]]), cloud), /за границами/);
  const corrupt = fixture([[3, 0, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0]]);
  new DataView(corrupt).setUint8(15, 0);
  assert.throws(() => decodeCloud(corrupt, cloud), /Повреждённая/);
});

test('manifest enforces both measured clouds, right handed Z-up and safe exact file paths', () => {
  const exterior = { ...cloud, id: 'exterior', file: 'exterior.bin' };
  const manifest = { version: 1, coordinateSystem: 'right-handed-z-up', sourcePointCount: cloud.sourcePointCount * 2, bounds: cloud.bounds, interiorBounds: cloud.bounds, clouds: [exterior, cloud] };
  assert.equal(validateManifest(manifest), manifest);
  assert.throws(() => validateManifest({ ...manifest, coordinateSystem: 'y-up' }), /система координат/);
  assert.throws(() => validateManifest({ ...manifest, clouds: [cloud, cloud] }), /ровно два/);
  assert.throws(() => validateManifest({ ...manifest, clouds: [exterior, { ...cloud, file: '../private.bin' }] }), /имя файла/);
  assert.throws(() => validateManifest({ ...manifest, sourcePointCount: 1 }), /исходных точек/);
  assert.throws(() => validateManifest({ ...manifest, clouds: [exterior, { ...cloud, byteLength: 17 }] }), /количество точек/);
});

