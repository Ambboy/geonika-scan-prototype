import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let readCloud = async () => new ArrayBuffer(0);
try {
  ({ readCloud } = await import('../src/loader.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('/src/loader.mjs')) throw error;
}
const bytes = new Uint8Array(32).map((_, i) => i);
const meta = { id: 'exterior', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
const response = data => new Response(new ReadableStream({ start(controller) { controller.enqueue(data.slice(0, 7)); controller.enqueue(data.slice(7)); controller.close(); } }));

test('public loader streams the exact measured payload and reports bytes, then verifies SHA-256', async () => {
  const progress = [];
  const buffer = await readCloud('https://example.invalid/data/exterior.bin', meta, { onProgress: value => progress.push(value), fetchImpl: async () => response(bytes) });
  assert.deepEqual(new Uint8Array(buffer), bytes, 'download cannot be replaced by an empty ready state');
  assert.equal(progress.at(-1), 32);
  assert.ok(progress.every((value, i) => value <= 32 && (i === 0 || value >= progress[i - 1])));
});

test('loader never accepts HTTP failure, truncated data, excess bytes or wrong integrity', async () => {
  await assert.rejects(readCloud('test', meta, { fetchImpl: async () => new Response('', { status: 404 }) }), /HTTP 404/);
  await assert.rejects(readCloud('test', meta, { fetchImpl: async () => response(bytes.slice(1)) }), /Неполный/);
  await assert.rejects(readCloud('test', meta, { fetchImpl: async () => response(new Uint8Array(33)) }), /больше/);
  await assert.rejects(readCloud('test', { ...meta, sha256: '0'.repeat(64) }, { fetchImpl: async () => response(bytes) }), /Контрольная сумма/);
});

test('loader propagates cancellation rather than advertising downloaded data as ready', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readCloud('test', meta, { signal: controller.signal, fetchImpl: async () => response(bytes) }), { name: 'AbortError' });
});
