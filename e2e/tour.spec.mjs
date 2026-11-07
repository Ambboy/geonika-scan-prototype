import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifySurfaceAssets } from './surface-gate.mjs';

const pointManifest = JSON.parse(await readFile(new URL('../public/data/manifest.json', import.meta.url), 'utf8'));
let surfaces;
// Missing real meshes is an explicit failing integration gate, not a skipped
// acceptance or a generated substitute. `--list` still enumerates the tests.
test.beforeAll(async () => { surfaces = (await verifySurfaceAssets()).manifest; });
const evidence = process.env.SCAN_EVIDENCE_DIR || 'test-results/scan-tour';
const state = page => page.evaluate(() => window.__scanTour.getState());
const waitReady = (page, displayMode = 'surfaces') => page.waitForFunction(mode => { const value = window.__scanTour?.getState(); return value?.ready && value.displayMode === mode; }, displayMode, { timeout: 40000 });
const waitProgress = (page, progress) => expect.poll(async () => Math.abs((await state(page)).progress - progress)).toBeLessThan(0.0001);
const ids = ['exterior', 'interior'];
const meta = (mode, id) => mode === 'surfaces' ? surfaces.models.find(item => item.id === id) : pointManifest.clouds.find(item => item.id === id);
const primitiveKey = mode => mode === 'surfaces' ? 'renderedTriangles' : 'renderedPoints';
const fullCount = (mode, id, light = false) => mode === 'surfaces' ? meta(mode, id).triangleCount : Math.min(meta(mode, id).pointCount, light ? 200000 : Infinity);
async function shot(page, name) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: resolve(evidence, name), fullPage: false }); }
async function record(name, value) { await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, name), JSON.stringify(value, null, 2)); }
async function openMode(page, mode) {
  await page.goto('./'); await waitReady(page);
  if (mode === 'points') { await page.getByRole('button', { name: 'Точки', exact: true }).click(); await waitReady(page, mode); }
}
function assertPrimitives(value, mode) {
  expect(value.displayMode).toBe(mode);
  expect(value.renderedCalls).toBeGreaterThan(0);
  expect(value.renderedFrames).toBeGreaterThan(0);
  expect(value.camera.up).toEqual([0, 0, 1]);
  expect(value.loadedModels).toEqual(ids);
  expect(value.modelCounts).toEqual(Object.fromEntries(surfaces.models.map(model => [model.id, { vertexCount: model.vertexCount, triangleCount: model.triangleCount }])));
  if (mode === 'surfaces') { expect(value.renderedPoints).toBe(0); expect(value.renderedTriangles).toBeGreaterThan(0); }
  else { expect(value.renderedTriangles).toBe(0); expect(value.renderedPoints).toBeGreaterThan(0); expect(value.loadedClouds).toEqual(ids); }
}

for (const mode of ['surfaces', 'points']) {
  test(`real ${mode} WebGL vertical: scroll both ways, interior, orbit, return, genuine Z cut, quality`, async ({ page }) => {
    const errors = [], external = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => {
      requests.push(request.url());
      if (!request.url().startsWith('http://127.0.0.1:4178/') && !request.url().startsWith('data:')) external.push(request.url());
    });
    await openMode(page, mode);
    const initial = await state(page);
    assertPrimitives(initial, mode);
    expect(initial[primitiveKey(mode)]).toBe(fullCount(mode, 'exterior'));
    if (mode === 'surfaces') {
      expect(initial.loadedClouds).toEqual([]);
      expect(initial.renderedClouds).toEqual([]);
      expect(requests.filter(url => /data\/(.*\.bin|manifest\.json)(\?|$)/.test(url))).toEqual([]);
    } else expect(initial.cloudPointCounts).toEqual(Object.fromEntries(pointManifest.clouds.map(cloud => [cloud.id, cloud.pointCount])));
    await record(`desktop-${mode}-initial-state.json`, initial);
    await shot(page, `desktop-${mode}-overall.png`);
    await page.mouse.move(800, 400); await page.mouse.wheel(0, 1600);
    await expect.poll(async () => (await state(page)).progress).toBeGreaterThan(0.15);
    expect((await state(page)).camera.position).not.toEqual(initial.camera.position);
    await page.mouse.wheel(0, -1400);
    await expect.poll(async () => (await state(page)).progress).toBeLessThan(0.1);
    await page.getByRole('button', { name: '03 Внутри' }).click(); await waitProgress(page, 0.5);
    await expect.poll(async () => (await state(page))[primitiveKey(mode)]).toBe(fullCount(mode, 'interior'));
    const interior = await state(page); assertPrimitives(interior, mode);
    expect((mode === 'surfaces' ? interior.renderedModels : interior.renderedClouds).sort()).toEqual(ids);
    await record(`desktop-${mode}-interior-state.json`, interior);
    await shot(page, `desktop-${mode}-interior.png`);
    await page.getByRole('button', { name: 'Свободный осмотр' }).click();
    await expect.poll(async () => (await state(page)).mode).toBe('free');
    const free = await state(page);
    expect(await page.locator('#scan-canvas').evaluate(canvas => canvas.style.touchAction)).toBe('none');
    await page.mouse.move(800, 360); await page.mouse.down(); await page.mouse.move(1010, 430, { steps: 8 }); await page.mouse.up(); await page.mouse.wheel(0, -220);
    await expect.poll(async () => JSON.stringify((await state(page)).camera.position)).not.toBe(JSON.stringify(free.camera.position));
    expect((await state(page)).progress).toBe(free.progress);
    await page.keyboard.press('Escape'); await expect.poll(async () => (await state(page)).mode).toBe('route'); await waitProgress(page, 0.5);
    const returned = await state(page);
    returned.camera.position.forEach((value, i) => expect(Math.abs(value - interior.camera.position[i])).toBeLessThan(0.03));
    expect(await page.locator('#scan-canvas').evaluate(canvas => canvas.style.touchAction)).toBe('pan-y');
    await record(`desktop-${mode}-returned-state.json`, returned);
    await page.getByRole('button', { name: '04 Срез' }).click(); await waitProgress(page, 0.76);
    await expect(page.getByLabel('Высота среза интерьера по оси Z')).toBeVisible();
    await shot(page, `desktop-${mode}-section.png`);
    const roi = { x: 460, y: 200, width: 500, height: 320 };
    const frame = (await state(page)).renderedFrames;
    await page.locator('#slice-height').evaluate((input, max) => { input.value = String(max); input.dispatchEvent(new Event('input', { bubbles: true })); }, surfaces.interiorBounds.max[2]);
    await page.waitForFunction(before => window.__scanTour.getState().renderedFrames > before, frame);
    const full = await page.screenshot({ clip: roi }); const fixedCamera = (await state(page)).camera.position;
    const lowerFrame = (await state(page)).renderedFrames;
    await page.locator('#slice-height').evaluate((input, min) => { input.value = String(min + 0.3); input.dispatchEvent(new Event('input', { bubbles: true })); }, surfaces.interiorBounds.min[2]);
    await page.waitForFunction(before => window.__scanTour.getState().renderedFrames > before, lowerFrame);
    const cut = await page.screenshot({ clip: roi });
    expect(cut.equals(full), 'cut must change actual scene pixels away from labels').toBe(false);
    expect((await state(page)).camera.position).toEqual(fixedCamera);
    await page.getByRole('button', { name: 'Облегчённый' }).click();
    await expect.poll(async () => (await state(page))[primitiveKey(mode)]).toBe(fullCount(mode, 'interior', true));
    expect((await state(page)).pixelRatio).toBe(1); expect((await state(page)).lightMode).toBe(true);
    await page.getByRole('button', { name: '05 Обзор' }).click(); await waitProgress(page, 1);
    await expect.poll(async () => (await state(page))[primitiveKey(mode)]).toBe(ids.reduce((sum, id) => sum + fullCount(mode, id, true), 0));
    await record(`desktop-${mode}-light-overview-state.json`, await state(page));
    expect(await page.evaluate(() => Object.isFrozen(window.__scanTour) && Object.isFrozen(window.__scanTour.getState().camera.position) && Object.isFrozen(window.__scanTour.getState().modelCounts.exterior) && !Object.getOwnPropertyDescriptor(window, '__scanTour').writable)).toBe(true);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  });

  test(`390px mobile ${mode}: 44px targets, light mode, reduced motion, keyboard and orbit`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce', baseURL: 'http://127.0.0.1:4178/geonika-scan-prototype/' });
    const page = await context.newPage();
    try {
      await openMode(page, mode); const initial = await state(page); assertPrimitives(initial, mode);
      expect(initial.lightMode).toBe(true); expect(initial.reducedMotion).toBe(true); expect(initial.pixelRatio).toBe(1);
      expect(initial[primitiveKey(mode)]).toBe(fullCount(mode, 'exterior', true));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const targets = await page.locator('button:visible, summary:visible').evaluateAll(elements => elements.map(element => ({ name: element.textContent.trim(), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
      for (const target of targets) { expect(target.width, target.name).toBeGreaterThanOrEqual(44); expect(target.height, target.name).toBeGreaterThanOrEqual(44); }
      await record(`mobile-${mode}-initial-state.json`, initial); await shot(page, `mobile-${mode}-390-overall.png`);
      await page.keyboard.press('End'); await waitProgress(page, 1); await page.keyboard.press('Home'); await waitProgress(page, 0);
      await page.getByRole('button', { name: '04 Срез' }).tap(); await waitProgress(page, 0.76); await shot(page, `mobile-${mode}-390-section.png`);
      await page.keyboard.press('f'); expect((await state(page)).mode).toBe('free');
      const position = (await state(page)).camera.position; await page.keyboard.press('ArrowRight'); expect((await state(page)).camera.position).not.toEqual(position);
      await page.keyboard.press('Escape'); expect((await state(page)).mode).toBe('route');
    } finally { await context.close(); }
  });

  test(`${mode}: exterior is genuinely drawn while interior is held; ready stays false`, async ({ page }) => {
    let release; const held = new Promise(resolve => { release = resolve; });
    if (mode === 'points') { await page.goto('./'); await waitReady(page); }
    await page.route(`**/data/interior.${mode === 'surfaces' ? 'glb' : 'bin'}`, async route => { await held; await route.continue(); });
    try {
      if (mode === 'surfaces') await page.goto('./'); else await page.getByRole('button', { name: 'Точки', exact: true }).click();
      await expect.poll(async () => (await state(page))[mode === 'surfaces' ? 'loadedModels' : 'loadedClouds']).toEqual(['exterior']);
      await expect.poll(async () => (await state(page))[primitiveKey(mode)]).toBeGreaterThan(0);
      const loading = await state(page);
      expect(loading.ready).toBe(false); expect(loading.loadedBytes).toBe(meta(mode, 'exterior').byteLength); expect(loading.loadedBytes).toBeLessThan(loading.totalBytes);
      expect(loading[mode === 'surfaces' ? 'renderedPoints' : 'renderedTriangles']).toBe(0);
      await expect(page.locator('#load-status')).toBeVisible(); await expect(page.getByRole('button', { name: 'Свободный осмотр' })).toBeDisabled();
      await record(`loading-${mode}-exterior-state.json`, loading); await shot(page, `real-progress-${mode}-exterior-drawn.png`);
      release(); await waitReady(page, mode); assertPrimitives(await state(page), mode);
    } finally { release(); }
  });

  test(`${mode}: honest manifest failure retries into actual rendered geometry`, async ({ page }) => {
    if (mode === 'points') { await page.goto('./'); await waitReady(page); }
    await page.route(`**/data/${mode === 'surfaces' ? 'surfaces' : 'manifest'}.json`, route => route.fulfill({ status: 404, body: 'missing' }), { times: 1 });
    if (mode === 'surfaces') await page.goto('./'); else await page.getByRole('button', { name: 'Точки', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Не удалось открыть скан' })).toBeVisible();
    expect((await state(page)).ready).toBe(false); expect((await state(page))[primitiveKey(mode)]).toBe(0);
    await page.getByRole('button', { name: 'Повторить загрузку' }).click(); await waitReady(page, mode); assertPrimitives(await state(page), mode);
  });
}

test('cached display round trips preserve source camera, free ownership, route progress and section height without more requests', async ({ page }) => {
  const requests = []; page.on('request', request => { if (request.url().includes('/data/')) requests.push(request.url()); });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await openMode(page, 'points');
  await page.getByRole('button', { name: '04 Срез' }).click(); await waitProgress(page, 0.76);
  await page.locator('#slice-height').evaluate((input, height) => { input.value = String(height); input.dispatchEvent(new Event('input', { bubbles: true })); }, surfaces.interiorBounds.min[2] + 2);
  await page.getByRole('button', { name: 'Свободный осмотр' }).click(); await page.keyboard.press('ArrowRight');
  const before = await state(page), completedRequests = [...requests];
  for (const mode of ['surfaces', 'points', 'surfaces']) {
    await page.getByRole('button', { name: mode === 'surfaces' ? 'Поверхности' : 'Точки', exact: true }).click(); await waitReady(page, mode);
    const current = await state(page); assertPrimitives(current, mode);
    // OrbitControls spherical round trips introduce floating-point drift without a real camera reset.
    for (const key of ['position', 'target']) current.camera[key].forEach((value, axis) => expect(value).toBeCloseTo(before.camera[key][axis], 10));
    expect(current.camera.up).toEqual(before.camera.up); expect(current.progress).toBe(before.progress); expect(current.sectionHeight).toBe(before.sectionHeight); expect(current.mode).toBe('free');
  }
  expect(requests).toEqual(completedRequests);
  await page.keyboard.press('Escape'); expect((await state(page)).mode).toBe('route');
});

for (const fault of ['corrupt-manifest', 'truncated-manifest', 'corrupt-glb', 'truncated-glb']) {
  test(`surface refusal: ${fault} is never ready and can retry without fake points`, async ({ page }) => {
    if (fault.endsWith('manifest')) await page.route('**/data/surfaces.json', route => route.fulfill({ contentType: 'application/json', body: fault === 'corrupt-manifest' ? '{"models":[' : JSON.stringify({ ...surfaces, models: surfaces.models.slice(0, 1) }) }), { times: 1 });
    else {
      const bytes = await readFile(new URL('../public/data/exterior.glb', import.meta.url));
      const body = fault === 'truncated-glb' ? bytes.subarray(0, -4) : Buffer.from(bytes);
      if (fault === 'corrupt-glb') body[body.length - 1] ^= 1;
      await page.route('**/data/exterior.glb', route => route.fulfill({ contentType: 'model/gltf-binary', body }), { times: 1 });
    }
    await page.goto('./'); await expect(page.getByRole('heading', { name: 'Не удалось открыть скан' })).toBeVisible();
    const failed = await state(page); expect(failed.ready).toBe(false); expect(failed.renderedPoints).toBe(0); expect(failed.renderedTriangles).toBe(0); expect(failed.loadedClouds).toEqual([]);
    await page.getByRole('button', { name: 'Повторить загрузку' }).click(); await waitReady(page); assertPrimitives(await state(page), 'surfaces');
  });
}
for (const fault of ['corrupt', 'truncated']) {
  test(`lazy points refusal: ${fault} binary can retry; mesh cache survives`, async ({ page }) => {
    await page.goto('./'); await waitReady(page);
    const bytes = await readFile(new URL('../public/data/exterior.bin', import.meta.url));
    const body = fault === 'truncated' ? bytes.subarray(0, -16) : Buffer.from(bytes);
    if (fault === 'corrupt') body[0] ^= 1;
    await page.route('**/data/exterior.bin', route => route.fulfill({ contentType: 'application/octet-stream', body }), { times: 1 });
    await page.getByRole('button', { name: 'Точки', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Не удалось открыть скан' })).toBeVisible();
    expect((await state(page)).ready).toBe(false); expect((await state(page)).renderedPoints).toBe(0); expect((await state(page)).renderedTriangles).toBe(0);
    await page.getByRole('button', { name: 'Повторить загрузку' }).click(); await waitReady(page, 'points'); assertPrimitives(await state(page), 'points');
    await page.getByRole('button', { name: 'Поверхности', exact: true }).click(); await waitReady(page); assertPrimitives(await state(page), 'surfaces');
  });
}

test('WebGL unavailable is a clear fallback, never a ready image or fake primitive count', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return type.startsWith('webgl') ? null : getContext.call(this, type, ...rest); };
  });
  await page.goto('./'); await expect(page.getByRole('heading', { name: 'WebGL недоступен' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Перезагрузить просмотр' })).toBeVisible();
  const current = await state(page);
  expect(current.ready).toBe(false); expect(current.renderedPoints).toBe(0); expect(current.renderedTriangles).toBe(0); expect(current.loadedClouds).toEqual([]); expect(current.loadedModels).toEqual([]);
});
