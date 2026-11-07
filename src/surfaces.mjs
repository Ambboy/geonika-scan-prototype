import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBounds } from './cloud.mjs';
import { readCloud } from './loader.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = message => { throw new Error(`Некорректная модель поверхности: ${message}.`); };

export function validateSurfaceModel(model) {
  if (!model || !['exterior', 'interior'].includes(model.id) || model.file !== `${model.id}.glb`) fail('имя файла');
  if (!positive(model.byteLength) || model.byteLength < 32 || model.byteLength > MAX_BYTES || typeof model.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(model.sha256)) fail('размер или SHA-256');
  if (!positive(model.vertexCount) || model.vertexCount > 5000000 || !positive(model.triangleCount) || model.triangleCount > 5000000 || !positive(model.sourcePointCount)) fail('количество вершин, треугольников или исходных точек');
  if (typeof model.method !== 'string' || !model.method.trim() || model.method.length > 4000) fail('метод реконструкции');
  validateBounds(model.bounds, model.id);
  return model;
}

export function validateSurfaceManifest(manifest) {
  if (!manifest || manifest.version !== 1 || manifest.coordinateSystem !== 'right-handed-z-up' || manifest.assetUpAxis !== 'Y' || manifest.assetToSourceRotation !== 'x+90deg') fail('версия или система координат');
  validateBounds(manifest.bounds);
  validateBounds(manifest.interiorBounds, 'interiorBounds');
  if (!Array.isArray(manifest.models) || manifest.models.length !== 2 || new Set(manifest.models.map(model => model?.id)).size !== 2) fail('нужны ровно две модели: exterior и interior');
  manifest.models.forEach(validateSurfaceModel);
  if (!positive(manifest.sourcePointCount) || manifest.sourcePointCount !== manifest.models.reduce((sum, model) => sum + model.sourcePointCount, 0)) fail('количество исходных точек');
  for (const model of manifest.models) {
    if (model.bounds.min.some((value, axis) => value < manifest.bounds.min[axis] - 0.05) || model.bounds.max.some((value, axis) => value > manifest.bounds.max[axis] + 0.05)) fail('границы модели вне общих границ');
  }
  return manifest;
}

// Inspect the complete container BEFORE GLTFLoader can resolve a dependency.
// This intentionally accepts only static, colored triangle glTF, not arbitrary
// glTF plugins, textures, animations, compressed payloads or external resources.
export function inspectStandaloneGLB(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 32 || buffer.byteLength > MAX_BYTES) fail('неполный GLB');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength) fail('заголовок или длина GLB');
  const chunks = [];
  for (let offset = 12; offset < buffer.byteLength;) {
    if (offset + 8 > buffer.byteLength) fail('неполный заголовок чанка GLB');
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (!length || length % 4 || offset + 8 + length > buffer.byteLength) fail('неполный или неверный чанк GLB');
    chunks.push({ type, offset: offset + 8, length });
    offset += 8 + length;
  }
  if (chunks.length !== 2 || chunks[0].type !== 0x4e4f534a || chunks[1].type !== 0x004e4942 || chunks[0].length > 2 * 1024 * 1024) fail('нужны только JSON и BIN чанки');
  let json;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, chunks[0].offset, chunks[0].length))); }
  catch { fail('повреждённый JSON GLB'); }
  if (json?.asset?.version !== '2.0') fail('версия glTF');
  const pending = [json];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri' || key === 'extensions' || key === 'extensionsUsed' || key === 'extensionsRequired') fail('запрещены URI и расширения glTF');
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  for (const key of ['images', 'textures', 'samplers', 'animations', 'skins', 'cameras']) if (json[key]?.length) fail(`запрещены ${key}`);
  if (!Array.isArray(json.buffers) || json.buffers.length !== 1 || !positive(json.buffers[0].byteLength) || json.buffers[0].byteLength > chunks[1].length || chunks[1].length - json.buffers[0].byteLength > 3) fail('standalone BIN buffer');
  const views = json.bufferViews;
  const accessors = json.accessors;
  if (!Array.isArray(views) || !views.length || !Array.isArray(accessors) || !accessors.length || accessors.length > 100000) fail('bufferViews/accessors');
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
  const at = (array, index, label) => { if (!nonnegative(index) || !array[index]) fail(label); return array[index]; };
  for (const item of views) {
    if (item.buffer !== 0 || !positive(item.byteLength) || !nonnegative(item.byteOffset ?? 0) || (item.byteOffset ?? 0) + item.byteLength > json.buffers[0].byteLength) fail('границы bufferView');
    if (item.byteStride !== undefined && (!Number.isInteger(item.byteStride) || item.byteStride < 4 || item.byteStride > 252 || item.byteStride % 4)) fail('byteStride');
  }
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 };
  const bytes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
  for (const item of accessors) {
    const bufferView = at(views, item.bufferView, 'bufferView accessor');
    const component = bytes[item.componentType];
    const components = width[item.type];
    const offset = item.byteOffset ?? 0;
    const stride = bufferView.byteStride ?? component * components;
    if (item.sparse || !component || !components || !positive(item.count) || item.count > 15000000 || !nonnegative(offset) || offset % component || ((bufferView.byteOffset ?? 0) + offset) % component || stride < component * components || offset + (item.count - 1) * stride + component * components > bufferView.byteLength) fail('границы или формат accessor');
  }
  if (!Array.isArray(json.meshes) || !json.meshes.length) fail('нет triangle mesh');
  for (const mesh of json.meshes) {
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length || mesh.weights) fail('primitives');
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4 || primitive.targets) fail('разрешены только статические TRIANGLES');
      const attrs = primitive.attributes;
      if (!attrs || Object.keys(attrs).some(key => !['POSITION', 'NORMAL', 'COLOR_0'].includes(key))) fail('атрибуты mesh');
      const position = at(accessors, attrs.POSITION, 'POSITION');
      const normal = at(accessors, attrs.NORMAL, 'NORMAL');
      const color = at(accessors, attrs.COLOR_0, 'COLOR_0');
      if (position.type !== 'VEC3' || position.componentType !== 5126 || position.normalized || normal.type !== 'VEC3' || normal.componentType !== 5126 || normal.normalized || normal.count !== position.count || !['VEC3', 'VEC4'].includes(color.type) || color.count !== position.count || ![5121, 5123, 5126].includes(color.componentType) || (color.componentType !== 5126 && color.normalized !== true)) fail('POSITION/NORMAL/COLOR_0');
      let count = position.count;
      if (primitive.indices !== undefined) {
        const index = at(accessors, primitive.indices, 'indices');
        if (index.type !== 'SCALAR' || ![5121, 5123, 5125].includes(index.componentType) || index.normalized) fail('indices');
        count = index.count;
      }
      if (count % 3) fail('число индексов не кратно трём');
      if (primitive.material !== undefined) at(json.materials ?? [], primitive.material, 'material');
    }
  }
  if (!Array.isArray(json.nodes) || json.nodes.length > 10000 || !Array.isArray(json.scenes) || json.scenes.length !== 1 || (json.scene ?? 0) !== 0 || !Array.isArray(json.scenes[0].nodes)) fail('scene/nodes');
  const visited = new Set();
  function visit(index, depth = 0) {
    const node = at(json.nodes, index, 'node');
    if (depth > 128 || visited.has(index)) fail('цикл или повторный node');
    visited.add(index);
    if (node.skin !== undefined || node.camera !== undefined || node.weights) fail('неподдерживаемый node');
    if (node.mesh !== undefined) at(json.meshes, node.mesh, 'node mesh');
    if (node.matrix && (node.translation || node.rotation || node.scale)) fail('смешанные transforms');
    for (const [key, length] of [['matrix', 16], ['translation', 3], ['rotation', 4], ['scale', 3]]) {
      if (node[key] !== undefined && (!Array.isArray(node[key]) || node[key].length !== length || !node[key].every(Number.isFinite))) fail('transform node');
    }
    if (node.children !== undefined && !Array.isArray(node.children)) fail('children');
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  for (const root of json.scenes[0].nodes) visit(root);
  if (visited.size !== json.nodes.length) fail('неиспользуемые nodes');
  return json;
}

export function disposeSurface(group) {
  const geometries = new Set();
  const materials = new Set();
  group.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

export async function parseSurface(buffer, model) {
  validateSurfaceModel(model);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== model.byteLength) fail(`неполный файл ${model.id}`);
  inspectStandaloneGLB(buffer);
  // Defense in depth: even a future GLTFLoader dependency must not reach the
  // network. No load(url), texture, decoder or CDN request is permitted here.
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(() => fail('внешняя зависимость GLB'));
  const gltf = await new GLTFLoader(manager).parseAsync(buffer, '');
  const group = new THREE.Group();
  group.name = `surface-${model.id}`;
  group.rotation.x = Math.PI / 2;
  group.add(gltf.scene);
  group.updateMatrixWorld(true);
  let vertexCount = 0;
  let triangleCount = 0;
  const point = new THREE.Vector3();
  try {
    group.traverse(object => {
      if (object.isPoints || object.isLine || object.isSkinnedMesh || object.isInstancedMesh) fail('не triangle Mesh');
      if (!object.isMesh) return;
      if (object.matrixWorld.determinant() <= 0) fail('отражённые или вырожденные оси');
      const { position, normal, color } = object.geometry.attributes;
      if (!position || !normal || !color) fail('нет позиции, нормали или цвета');
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
        if (point.toArray().some((value, axis) => !Number.isFinite(value) || value < model.bounds.min[axis] - 0.03 || value > model.bounds.max[axis] + 0.03)) fail('координаты вне source XYZ bounds');
        point.fromBufferAttribute(normal, i);
        if (!point.toArray().every(Number.isFinite) || point.lengthSq() < 0.01 || point.lengthSq() > 1.03) fail('нормали');
        for (let axis = 0; axis < color.itemSize; axis++) { const value = color.getComponent(i, axis); if (!Number.isFinite(value) || value < 0 || value > 1) fail('linear RGB'); }
      }
      const index = object.geometry.index;
      if (index) for (let i = 0; i < index.count; i++) if (index.getX(i) >= position.count) fail('индекс вне mesh');
      vertexCount += position.count;
      triangleCount += (index ? index.count : position.count) / 3;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material.isMeshStandardMaterial) fail('материал');
        material.metalness = 0;
        material.roughness = 1;
        material.vertexColors = true;
        material.toneMapped = false;
        material.forceSinglePass = true;
        // COLOR_0 is Linear-sRGB already. Never convert this attribute again.
      }
    });
    if (vertexCount !== model.vertexCount || triangleCount !== model.triangleCount) fail('количество вершин/треугольников не совпало с манифестом');
    if (!triangleCount) fail('нет треугольников');
    return { group, vertexCount, triangleCount };
  } catch (error) { disposeSurface(group); throw error; }
}

export async function readSurface(url, model, options) {
  validateSurfaceModel(model);
  const buffer = await readCloud(url, model, options);
  return parseSurface(buffer, model);
}

// Three discards the negative signed-distance half-space. With -Z normal
// this is z > height in source Z-up, irrespective of the Y-up GLB graph.
export function surfaceClipPlane(height) {
  if (!Number.isFinite(height)) fail('высота среза');
  return new THREE.Plane(new THREE.Vector3(0, 0, -1), height);
}
