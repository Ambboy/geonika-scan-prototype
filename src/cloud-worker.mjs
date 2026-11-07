import { decodeCloud } from './cloud.mjs';

self.onmessage = event => {
  try {
    const result = decodeCloud(event.data.buffer, event.data.cloud);
    self.postMessage({ ok: true, ...result }, [result.positions.buffer, result.colors.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, error: error.message });
  }
};
