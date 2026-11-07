import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateSurfaceManifest, parseSurface } from '../src/surfaces.mjs';

export async function verifySurfaceAssets() {
  const data = new URL('../public/data/', import.meta.url);
  let manifest;
  try { manifest = validateSurfaceManifest(JSON.parse(await readFile(new URL('surfaces.json', data), 'utf8'))); }
  catch (error) { throw new Error(`MESH INTEGRATION GATE: нужны актуальные public/data/surfaces.json + exterior.glb + interior.glb. ${error.message}`); }
  const models = {};
  for (const meta of manifest.models) {
    const bytes = await readFile(new URL(meta.file, data));
    if (bytes.length !== meta.byteLength) throw new Error(`MESH INTEGRATION GATE: размер ${meta.file} не совпал.`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== meta.sha256.toLowerCase()) throw new Error(`MESH INTEGRATION GATE: SHA-256 ${meta.file} не совпала.`);
    const parsed = await parseSurface(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), meta);
    models[meta.id] = { byteLength: bytes.length, sha256, vertexCount: parsed.vertexCount, triangleCount: parsed.triangleCount };
  }
  return { manifest, models };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { manifest, models } = await verifySurfaceAssets();
    console.log(JSON.stringify({ gate: 'PASS_ASSETS_ONLY_NOT_GPU', coordinateSystem: manifest.coordinateSystem, models }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
