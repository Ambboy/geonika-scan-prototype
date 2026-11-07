export async function readCloud(url, cloud, { onProgress = () => {}, signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { signal, credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error(`Не удалось загрузить ${cloud.id} (HTTP ${response.status}).`);
  let buffer;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const bytes = new Uint8Array(cloud.byteLength);
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > bytes.byteLength) throw new Error(`Размер ${cloud.id} больше указанного в манифесте.`);
        bytes.set(value, offset);
        offset += value.byteLength;
        onProgress(offset);
      }
      if (offset !== bytes.byteLength) throw new Error(`Неполный файл ${cloud.id}: ${offset} из ${bytes.byteLength} байт.`);
      buffer = bytes.buffer;
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  } else {
    buffer = await response.arrayBuffer();
    if (buffer.byteLength !== cloud.byteLength) throw new Error(`Неполный файл ${cloud.id}.`);
    onProgress(buffer.byteLength);
  }
  if (signal?.aborted) throw new DOMException('Загрузка отменена.', 'AbortError');
  if (!globalThis.crypto?.subtle) throw new Error('Проверка скана требует защищённого соединения HTTPS.');
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (sha256 !== cloud.sha256.toLowerCase()) throw new Error(`Контрольная сумма ${cloud.id} не совпала. Файл повреждён.`);
  return buffer;
}
