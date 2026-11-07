import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Vector3, Matrix3, Scene, PerspectiveCamera } from 'three';
import { ScanScene } from '../src/scene.mjs';

let parseSurface = async () => null;
let validateSurfaceManifest;
let readSurface;
let surfaceClipPlane;
let ScanAssets = class { async load() { return null; } };
try { ({ ScanAssets } = await import('../src/assets.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('/src/assets.mjs')) throw error; }
try {
  ({ parseSurface, validateSurfaceManifest, readSurface, surfaceClipPlane } = await import('../src/surfaces.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('/src/surfaces.mjs')) throw error;
}

// An explicitly synthetic, valid standalone GLB. Never used as a site asset.
function fixture(change = () => {}) {
  const position = new Float32Array([2, -3, -1, 4, -3, 1, 2, 1, 1]);
  const normal = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const color = new Float32Array([0.2158605, 0, 1, 0.2158605, 0, 1, 0.2158605, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);
  const bin = new Uint8Array(116);
  [position, normal, color, indices].forEach((array, i) => bin.set(new Uint8Array(array.buffer), [0, 36, 72, 108][i]));
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: [1] }, { mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }, { buffer: 0, byteOffset: 72, byteLength: 36 }, { buffer: 0, byteOffset: 108, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [2, -3, -1], max: [4, 1, 1] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
  };
  change(json, bin);
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(text.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + padded + 8 + bin.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + padded); bytes.set(text, 20);
  view.setUint32(20 + padded, bin.length, true); view.setUint32(24 + padded, 0x004e4942, true); bytes.set(bin, 28 + padded);
  const model = { id: 'exterior', file: 'exterior.glb', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), vertexCount: 3, triangleCount: 1, sourcePointCount: 300, bounds: { min: [2, -3, -1], max: [4, 1, 1] }, method: 'synthetic fixture, not measured data' };
  return { bytes, model };
}

function manifest(model) {
  return { version: 1, coordinateSystem: 'right-handed-z-up', assetUpAxis: 'Y', assetToSourceRotation: 'x+90deg', sourcePointCount: 600, bounds: model.bounds, interiorBounds: model.bounds, models: [model, { ...model, id: 'interior', file: 'interior.glb' }] };
}

test('public GLB parser returns genuine colored triangle Mesh and reverses Y-up to measured Z-up exactly once', async () => {
  const { bytes, model } = fixture();
  const parsed = await parseSurface(bytes.buffer, model);
  assert.ok(parsed?.group?.isGroup, 'surface mode must contain a parsed real mesh, never an empty/point placeholder');
  const meshes = [];
  parsed.group.traverse(object => { assert.ok(!object.isPoints && !object.isLine); if (object.isMesh) meshes.push(object); });
  assert.equal(meshes.length, 1);
  assert.equal(parsed.vertexCount, 3);
  assert.equal(parsed.triangleCount, 1);
  parsed.group.updateMatrixWorld(true);
  const mesh = meshes[0];
  const source = new Vector3().fromBufferAttribute(mesh.geometry.attributes.position, 1).applyMatrix4(mesh.matrixWorld);
  source.toArray().forEach((value, i) => assert.ok(Math.abs(value - [4, -3, 1][i]) < 1e-6));
  const normal = new Vector3().fromBufferAttribute(mesh.geometry.attributes.normal, 0).applyMatrix3(new Matrix3().getNormalMatrix(mesh.matrixWorld));
  normal.toArray().forEach((value, i) => assert.ok(Math.abs(value - [0, 0, 1][i]) < 1e-6));
  assert.ok(Math.abs(mesh.geometry.attributes.color.getX(0) - 0.2158605) < 1e-6, 'GLB COLOR_0 is already linear; do not linearize it twice');
  assert.equal(mesh.material.metalness, 0);
  assert.equal(mesh.material.roughness, 1);
  assert.equal(mesh.material.vertexColors, true);
});


test('surface manifest rejects missing, corrupt, truncated metadata, unsafe paths, counts and axis drift', () => {
  const { model } = fixture();
  const valid = manifest(model);
  assert.equal(validateSurfaceManifest(valid), valid);
  for (const invalid of [null, {}, { ...valid, version: 2 }, { ...valid, assetUpAxis: 'Z' }, { ...valid, assetToSourceRotation: 'x-90deg' }, { ...valid, sourcePointCount: 1 }, { ...valid, models: valid.models.slice(0, 1) }, { ...valid, models: [model, model] }, { ...valid, bounds: { min: [NaN, 0, 0], max: [1, 1, 1] } }]) assert.throws(() => validateSurfaceManifest(invalid));
  for (const change of [{ file: '../exterior.glb' }, { file: 'https://example.invalid/exterior.glb' }, { byteLength: 0 }, { byteLength: 1000000000 }, { sha256: 'z'.repeat(64) }, { vertexCount: -1 }, { triangleCount: 0 }, { sourcePointCount: 0 }, { method: '' }]) assert.throws(() => validateSurfaceManifest({ ...valid, models: [{ ...model, ...change }, valid.models[1]] }));
  assert.throws(() => JSON.parse('{"models":['), SyntaxError);
});

test('standalone parser rejects external/data URIs, textures, Draco, nontriangles, sparse data and node cycles before loading', async () => {
  const edits = [
    json => { json.buffers[0].uri = 'https://example.invalid/track.bin'; },
    json => { json.buffers[0].uri = 'data:application/octet-stream;base64,AA=='; },
    json => { json.images = [{ uri: 'https://example.invalid/track.png' }]; },
    json => { json.textures = [{}]; },
    json => { json.extensionsUsed = ['KHR_draco_mesh_compression']; },
    json => { json.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} }; },
    json => { json.meshes[0].primitives[0].mode = 0; },
    json => { delete json.meshes[0].primitives[0].attributes.NORMAL; },
    json => { json.accessors[0].sparse = { count: 3 }; },
    json => { json.nodes[1].children = [0]; },
    json => { json.bufferViews[0].byteLength = 4000000; },
    json => { json.accessors[0].count = 4000000; },
  ];
  for (const edit of edits) {
    const { bytes, model } = fixture(edit);
    await assert.rejects(parseSurface(bytes.buffer, model), /Некорректная/);
  }
});

test('GLB header, chunk truncation, corrupt JSON, out-of-range indices, nonfinite positions and wrong counts fail closed', async () => {
  const { bytes, model } = fixture();
  await assert.rejects(parseSurface(bytes.buffer.slice(0, -4), model), /неполный/);
  const header = bytes.slice(); new DataView(header.buffer).setUint32(8, bytes.length + 4, true);
  await assert.rejects(parseSurface(header.buffer, model), /заголовок|длина/);
  const chunk = bytes.slice(); new DataView(chunk.buffer).setUint32(12, bytes.length * 2, true);
  await assert.rejects(parseSurface(chunk.buffer, model), /чанк/);
  const json = bytes.slice(); json[20] = 0xff;
  await assert.rejects(parseSurface(json.buffer, model), /JSON/);
  for (const edit of [(_, bin) => new DataView(bin.buffer).setUint16(108, 5000, true), (_, bin) => new DataView(bin.buffer).setFloat32(0, NaN, true), (_, bin) => new DataView(bin.buffer).setFloat32(0, 5000, true), (_, bin) => new DataView(bin.buffer).setFloat32(72, 2, true), json => { json.nodes[0].scale = [-1, 1, 1]; }]) {
    const changed = fixture(edit);
    await assert.rejects(parseSurface(changed.bytes.buffer, changed.model), /Некорректная/);
  }
  await assert.rejects(parseSurface(bytes.buffer, { ...model, triangleCount: 2 }), /количество/);
});

test('public surface loader validates streamed size and SHA before standalone parsing', async () => {
  const { bytes, model } = fixture();
  const progress = [];
  const parsed = await readSurface('https://example.invalid/exterior.glb', model, { fetchImpl: async () => new Response(bytes), onProgress: value => progress.push(value) });
  assert.equal(parsed.triangleCount, 1);
  assert.equal(progress.at(-1), bytes.length);
  await assert.rejects(readSurface('test', model, { fetchImpl: async () => new Response(bytes.slice(0, -4)) }), /Неполный/);
  await assert.rejects(readSurface('test', model, { fetchImpl: async () => new Response(new Uint8Array(bytes.length + 4)) }), /больше/);
  const corrupt = bytes.slice(); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(readSurface('test', model, { fetchImpl: async () => new Response(corrupt) }), /Контрольная сумма/);
});

test('mesh clipping plane keeps original world Z below the height after reversible Y-up restoration', async () => {
  const { bytes, model } = fixture();
  const parsed = await parseSurface(bytes.buffer, model);
  let mesh;
  parsed.group.traverse(object => { if (object.isMesh) mesh = object; });
  const plane = surfaceClipPlane(0);
  for (let index = 0; index < 3; index++) {
    const world = new Vector3().fromBufferAttribute(mesh.geometry.attributes.position, index).applyMatrix4(mesh.matrixWorld);
    assert.equal(plane.distanceToPoint(world) >= 0, world.z <= 0);
    assert.ok(Math.abs(surfaceClipPlane(world.z).distanceToPoint(world)) < 1e-6);
  }
  assert.throws(() => surfaceClipPlane(NaN));
});

test('public asset store defaults to two real mesh parses; points are lazy; repeated switches do not download again', async () => {
  const { bytes, model } = fixture();
  const requests = [];
  const pointBytes = new Uint8Array(16);
  const view = new DataView(pointBytes.buffer);
  [3, -2, 0].forEach((value, axis) => view.setFloat32(axis * 4, value, true));
  pointBytes.set([128, 0, 255, 255], 12);
  const cloud = id => ({ id, file: `${id}.bin`, format: 'xyz-f32-rgb8-stride16', pointCount: 1, byteLength: 16, sha256: createHash('sha256').update(pointBytes).digest('hex'), sourcePointCount: 300, bounds: model.bounds });
  const pointManifest = { version: 1, coordinateSystem: 'right-handed-z-up', sourcePointCount: 600, bounds: model.bounds, interiorBounds: model.bounds, clouds: [cloud('exterior'), cloud('interior')] };
  const store = new ScanAssets({ dataURL: new URL('https://example.invalid/data/'), fetchImpl: async url => {
    const file = new URL(url).pathname.split('/').at(-1);
    requests.push(file);
    if (file === 'surfaces.json') return Response.json(manifest(model));
    if (file === 'manifest.json') return Response.json(pointManifest);
    return new Response(file.endsWith('.glb') ? bytes : pointBytes);
  } });
  await store.load();
  assert.deepEqual(requests, ['surfaces.json', 'exterior.glb', 'interior.glb'], 'the default public path must parse mesh and must not request old bins');
  assert.deepEqual([...store.models.keys()], ['exterior', 'interior']);
  assert.equal(store.clouds.size, 0);
  await store.load('points');
  assert.deepEqual([...store.clouds.keys()], ['exterior', 'interior']);
  const completed = [...requests];
  await store.load('surfaces'); await store.load('points');
  assert.deepEqual(requests, completed, 'all validated assets, including manifests, are reused');
  await assert.rejects(store.load('fake'), /режим/);
});

test('public asset store invokes strict fetch detached and preserves request options', async () => {
  const { bytes, model } = fixture();
  const valid = manifest(model);
  const controller = new AbortController();
  const requests = [];
  const assets = [];
  async function fetchImpl(url, options) {
    if (this !== undefined) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    assert.equal(options.signal, controller.signal);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    const file = new URL(url).pathname.split('/').at(-1);
    requests.push(file);
    if (file === 'surfaces.json') {
      assert.equal(options.cache, 'no-cache');
      return Response.json(valid);
    }
    assert.ok(['exterior.glb', 'interior.glb'].includes(file), 'only the selected surface assets may be fetched');
    return new Response(bytes);
  }
  const store = new ScanAssets({ dataURL: new URL('https://example.invalid/data/'), fetchImpl });
  assert.deepEqual(requests, [], 'construction must remain lazy');
  const loaded = await store.load('surfaces', { signal: controller.signal, onAsset: (meta, value) => assets.push({ meta, value }) });
  assert.deepEqual(loaded, valid);
  assert.deepEqual(requests, ['surfaces.json', 'exterior.glb', 'interior.glb']);
  assert.deepEqual([...store.models.keys()], ['exterior', 'interior']);
  assert.equal(store.clouds.size, 0, 'surface loading must not request or decode points');
  assert.deepEqual(assets.map(({ meta }) => meta.id), ['exterior', 'interior']);
  for (const { value } of assets) {
    assert.ok(value.group.isGroup, 'load must return genuinely parsed fixture geometry');
    assert.equal(value.vertexCount, 3);
    assert.equal(value.triangleCount, 1);
  }
  await store.load('surfaces', { signal: controller.signal });
  assert.deepEqual(requests, ['surfaces.json', 'exterior.glb', 'interior.glb'], 'validated manifests and meshes must remain cached');
});

test('asset-store retry retains verified exterior and only re-fetches a failed interior', async () => {
  const { bytes, model } = fixture();
  const requests = [];
  let failInterior = true;
  const store = new ScanAssets({ dataURL: new URL('https://example.invalid/data/'), fetchImpl: async url => {
    const file = new URL(url).pathname.split('/').at(-1); requests.push(file);
    if (file === 'surfaces.json') return Response.json(manifest(model));
    if (file === 'interior.glb' && failInterior) { failInterior = false; return new Response(bytes.slice(0, -4)); }
    return new Response(bytes);
  } });
  await assert.rejects(store.load(), /Неполный/);
  assert.deepEqual([...store.models.keys()], ['exterior']);
  await store.load();
  assert.deepEqual([...store.models.keys()], ['exterior', 'interior']);
  assert.deepEqual(requests, ['surfaces.json', 'exterior.glb', 'interior.glb', 'interior.glb']);
});

test('asset-store public manifest path rejects malformed/truncated JSON and never starts a GLB or point request', async () => {
  const { model } = fixture();
  for (const payload of ['{"models":[', JSON.stringify({ ...manifest(model), models: [] }), JSON.stringify({ ...manifest(model), models: [{ ...model, file: '../secret.glb' }, manifest(model).models[1]] })]) {
    const requests = [];
    const store = new ScanAssets({ dataURL: new URL('https://example.invalid/data/'), fetchImpl: async url => { requests.push(String(url)); return new Response(payload); } });
    await assert.rejects(store.load(), /манифест|модел/i);
    assert.equal(store.models.size, 0);
    assert.equal(store.clouds.size, 0);
    assert.deepEqual(requests, ['https://example.invalid/data/surfaces.json']);
  }
});

test('normalized integer GLB color remains already-linear RGB, not source sRGB', async () => {
  const { bytes, model } = fixture((json, bin) => {
    json.accessors[2].componentType = 5121; json.accessors[2].normalized = true;
    bin.set([55, 0, 255, 55, 0, 255, 55, 0, 255], 72);
  });
  const { group } = await parseSurface(bytes.buffer, model);
  group.traverse(object => { if (object.isMesh) { assert.ok(Math.abs(object.geometry.attributes.color.getX(0) - 55 / 255) < 1e-6); assert.equal(object.geometry.attributes.color.getZ(0), 1); } });
});

test('real scene composition hides cached Points in surface mode and attaches the world-Z plane to triangle materials', async () => {
  const { bytes, model } = fixture();
  const parsed = await parseSurface(bytes.buffer, { ...model, id: 'interior', file: 'interior.glb' });
  // Only the WebGL constructor is omitted in this CPU composition check.
  // All geometry, material, visibility and mode methods below are production
  // ScanScene methods. Actual GPU acceptance remains the real-asset E2E gate.
  const scene = Object.assign(Object.create(ScanScene.prototype), {
    models: new Map(), clouds: new Map(), scene: new Scene(), camera: new PerspectiveCamera(),
    renderer: { getPixelRatio: () => 1 }, displayMode: 'surfaces', renderedModels: new Set(), renderedClouds: new Set(), lightMode: false,
  });
  const previousWindow = globalThis.window;
  globalThis.window = { innerHeight: 900 };
  try {
    scene.addSurface({ ...model, id: 'interior' }, parsed);
    scene.addCloud({ id: 'interior', pointCount: 1, bounds: model.bounds }, { positions: new Float32Array([3, -2, 0]), colors: new Float32Array([0.2, 0.3, 0.4]) });
    scene.setCloudState({ interior: 1, exterior: 0 }, 0.5);
    const surface = scene.models.get('interior');
    const points = scene.clouds.get('interior').points;
    assert.equal(surface.group.visible, true);
    assert.equal(points.visible, false, 'even an already-loaded Points object must not be submitted in mesh mode');
    for (const material of surface.materials) {
      assert.equal(material.clippingPlanes[0], surface.clipPlane);
      assert.deepEqual(material.clippingPlanes[0].normal.toArray(), [0, 0, -1]);
      assert.equal(material.clippingPlanes[0].constant, 0.5);
    }
    scene.setDisplayMode('points');
    assert.equal(surface.group.visible, false); assert.equal(points.visible, true);
    assert.equal(scene.renderedTriangles, 0); assert.equal(scene.drawnDisplayMode, null);
    scene.setDisplayMode('surfaces');
    assert.equal(surface.group.visible, true); assert.equal(points.visible, false);
    assert.equal(scene.models.size, 1); assert.equal(scene.clouds.size, 1);
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    scene.clear();
  }
});
