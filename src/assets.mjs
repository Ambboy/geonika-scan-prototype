import { validateManifest, decodeCloud } from './cloud.mjs';
import { readCloud } from './loader.mjs';
import { validateSurfaceManifest, parseSurface } from './surfaces.mjs';

// Keep the two data paths separate. Merely creating this store performs no
// fetch, and the default load has no reason to read the 24 MB point payload.
export class ScanAssets {
  constructor({ dataURL, fetchImpl = fetch, decodePoints = decodeCloud }) {
    this.dataURL = dataURL;
    this.fetchImpl = fetchImpl;
    this.decodePoints = decodePoints;
    this.models = new Map();
    this.clouds = new Map();
    this.manifests = new Map();
  }

  async load(displayMode = 'surfaces', { signal, onProgress = () => {}, onPhase = () => {}, onAsset = () => {}, onManifest = () => {} } = {}) {
    if (!['surfaces', 'points'].includes(displayMode)) throw new Error('Неизвестный режим просмотра.');
    const surfaces = displayMode === 'surfaces';
    const cache = surfaces ? this.models : this.clouds;
    let manifest = this.manifests.get(displayMode);
    if (!manifest) {
      onPhase('manifest');
      const fetchImpl = this.fetchImpl;
      const response = await fetchImpl(new URL(surfaces ? 'surfaces.json' : 'manifest.json', this.dataURL), { signal, credentials: 'same-origin', cache: 'no-cache', redirect: 'error' });
      if (!response.ok) throw new Error(`Манифест скана недоступен (HTTP ${response.status}). Проверьте соединение и повторите.`);
      let json;
      try {
        const text = await response.text();
        if (text.length > 256 * 1024) throw new Error('oversize');
        json = JSON.parse(text);
      } catch { throw new Error('Сервер вернул некорректный манифест скана.'); }
      manifest = surfaces ? validateSurfaceManifest(json) : validateManifest(json);
      this.manifests.set(displayMode, manifest);
    }
    if (signal?.aborted) throw new DOMException('Загрузка отменена.', 'AbortError');
    onManifest(manifest);
    const items = surfaces ? manifest.models : manifest.clouds;
    const total = items.reduce((sum, item) => sum + item.byteLength, 0);
    let completed = items.reduce((sum, item) => sum + (cache.has(item.id) ? item.byteLength : 0), 0);
    onProgress(completed, total);
    // Draw the validated exterior while the interior request is in progress.
    for (const id of ['exterior', 'interior']) {
      if (cache.has(id)) continue;
      const meta = items.find(item => item.id === id);
      onPhase('download', id);
      const buffer = await readCloud(new URL(meta.file, this.dataURL), meta, { signal, fetchImpl: this.fetchImpl, onProgress: bytes => onProgress(completed + bytes, total) });
      onPhase('parse', id);
      const value = surfaces ? await parseSurface(buffer, meta) : await this.decodePoints(buffer, meta, signal);
      if (signal?.aborted) throw new DOMException('Загрузка отменена.', 'AbortError');
      cache.set(id, { meta, value });
      onAsset(meta, value);
      completed += meta.byteLength;
      onProgress(completed, total);
    }
    return manifest;
  }
}
