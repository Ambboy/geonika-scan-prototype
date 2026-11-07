export const POINT_STRIDE = 16;
export const CLOUD_FORMAT = 'xyz-f32-rgb8-stride16';

const linearColor = Float32Array.from({ length: 256 }, (_, i) => {
  const s = i / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

export function validateBounds(bounds, name = 'bounds') {
  if (!bounds || !['min', 'max'].every(key => Array.isArray(bounds[key]) && bounds[key].length === 3 && bounds[key].every(Number.isFinite))) {
    throw new Error(`Некорректные границы ${name}.`);
  }
  if (bounds.min.some((value, i) => value >= bounds.max[i])) throw new Error(`Пустые границы ${name}.`);
  return { min: [...bounds.min], max: [...bounds.max] };
}

function validateCloud(cloud) {
  if (!cloud || !['exterior', 'interior'].includes(cloud.id) || cloud.file !== `${cloud.id}.bin` || cloud.format !== CLOUD_FORMAT) {
    throw new Error('Неизвестный формат облака или имя файла.');
  }
  if (!Number.isSafeInteger(cloud.pointCount) || cloud.pointCount < 1 || cloud.byteLength !== cloud.pointCount * POINT_STRIDE) {
    throw new Error(`Некорректное количество точек: ${cloud.id}.`);
  }
  if (!Number.isSafeInteger(cloud.sourcePointCount) || cloud.sourcePointCount < cloud.pointCount || !/^[a-f0-9]{64}$/i.test(cloud.sha256)) {
    throw new Error(`Некорректные метаданные: ${cloud.id}.`);
  }
  validateBounds(cloud.bounds, cloud.id);
  return cloud;
}

export function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || manifest.coordinateSystem !== 'right-handed-z-up') {
    throw new Error('Неподдерживаемая версия скана или система координат.');
  }
  validateBounds(manifest.bounds);
  validateBounds(manifest.interiorBounds, 'interiorBounds');
  if (!Array.isArray(manifest.clouds) || manifest.clouds.length !== 2 || new Set(manifest.clouds.map(cloud => cloud.id)).size !== 2) {
    throw new Error('В скане должны быть ровно два облака: снаружи и внутри.');
  }
  manifest.clouds.forEach(validateCloud);
  if (!Number.isSafeInteger(manifest.sourcePointCount) || manifest.sourcePointCount !== manifest.clouds.reduce((sum, cloud) => sum + cloud.sourcePointCount, 0)) {
    throw new Error('Количество исходных точек не совпадает с манифестом.');
  }
  return manifest;
}

// No axis swap, centering, mirroring or invented geometry. Positions are the
// source Float32 XYZ; source RGB is explicitly sRGB → Linear-sRGB once.
export function decodeCloud(buffer, cloud) {
  validateCloud(cloud);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== cloud.byteLength) {
    throw new Error(`Неполный файл ${cloud.id}: ожидается ${cloud.byteLength} байт.`);
  }
  const view = new DataView(buffer);
  const positions = new Float32Array(cloud.pointCount * 3);
  const colors = new Float32Array(cloud.pointCount * 3);
  for (let i = 0; i < cloud.pointCount; i++) {
    const offset = i * POINT_STRIDE;
    const vertex = i * 3;
    for (let axis = 0; axis < 3; axis++) {
      const value = view.getFloat32(offset + axis * 4, true);
      if (!Number.isFinite(value)) throw new Error(`Нечисловая координата: ${cloud.id}, точка ${i}.`);
      if (value < cloud.bounds.min[axis] - 0.01 || value > cloud.bounds.max[axis] + 0.01) {
        throw new Error(`Точка за границами манифеста: ${cloud.id}, точка ${i}.`);
      }
      positions[vertex + axis] = value;
      colors[vertex + axis] = linearColor[view.getUint8(offset + 12 + axis)];
    }
    if (view.getUint8(offset + 15) !== 255) throw new Error(`Повреждённая запись: ${cloud.id}, точка ${i}.`);
  }
  return { positions, colors, pointCount: cloud.pointCount };
}
