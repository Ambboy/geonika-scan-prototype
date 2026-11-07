import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifest = JSON.parse(await readFile(new URL('../public/data/manifest.json', import.meta.url), 'utf8'));
const evidence = process.env.SCAN_EVIDENCE_DIR || 'test-results/scan-tour';
const state = page => page.evaluate(() => window.__scanTour.getState());
const waitReady = page => page.waitForFunction(() => window.__scanTour?.getState().ready, null, { timeout: 40000 });
const waitProgress = (page, progress) => expect.poll(async () => Math.abs((await state(page)).progress - progress)).toBeLessThan(0.0001);
async function shot(page, name) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: resolve(evidence, name), fullPage: false }); }
async function record(name, value) { await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, name), JSON.stringify(value, null, 2)); }

test('real two-cloud WebGL vertical: scroll both ways, interior, orbit, return, genuine height cut, quality', async ({ page }) => {
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4178/') && !request.url().startsWith('data:')) external.push(request.url()); });
  await page.goto('./');
  await waitReady(page);
  const initial = await state(page);
  await record('desktop-initial-state.json', initial);
  expect(initial.loadedClouds).toEqual(['exterior', 'interior']);
  expect(initial.cloudPointCounts).toEqual(Object.fromEntries(manifest.clouds.map(cloud => [cloud.id, cloud.pointCount])));
  expect(initial.renderedPoints).toBe(manifest.clouds.find(cloud => cloud.id === 'exterior').pointCount);
  expect(initial.renderedFrames).toBeGreaterThan(0);
  expect(initial.camera.up).toEqual([0, 0, 1]);
  await shot(page, 'desktop-overall.png');

  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, 1600);
  await expect.poll(async () => (await state(page)).progress).toBeGreaterThan(0.15);
  const forward = await state(page);
  expect(forward.camera.position).not.toEqual(initial.camera.position);
  await page.mouse.wheel(0, -1400);
  await expect.poll(async () => (await state(page)).progress).toBeLessThan(0.1);

  await page.getByRole('button', { name: '03 Внутри' }).click();
  await waitProgress(page, 0.5);
  await expect.poll(async () => (await state(page)).renderedPoints).toBe(manifest.clouds.find(cloud => cloud.id === 'interior').pointCount);
  expect((await state(page)).renderedClouds.sort()).toEqual(['exterior', 'interior']);
  await shot(page, 'desktop-interior.png');
  const routePose = await state(page);
  await record('desktop-interior-state.json', routePose);

  await page.getByRole('button', { name: 'Свободный осмотр' }).click();
  await expect.poll(async () => (await state(page)).mode).toBe('free');
  // The route can finish smoothing between the earlier snapshot and the click.
  // Freeze the invariant at the actual free-mode boundary, not before it.
  const freePose = await state(page);
  await page.mouse.move(800, 360);
  await page.mouse.down();
  await page.mouse.move(1010, 430, { steps: 8 });
  await page.mouse.up();
  await page.mouse.wheel(0, -220);
  await expect.poll(async () => JSON.stringify((await state(page)).camera.position)).not.toBe(JSON.stringify(routePose.camera.position));
  expect((await state(page)).progress).toBe(freePose.progress);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).mode).toBe('route');
  await waitProgress(page, 0.5);
  const returned = await state(page);
  await record('desktop-returned-state.json', returned);
  returned.camera.position.forEach((value, i) => expect(Math.abs(value - routePose.camera.position[i])).toBeLessThan(0.03));

  await page.getByRole('button', { name: '04 Срез' }).click();
  await waitProgress(page, 0.76);
  await expect(page.getByLabel('Высота среза интерьера по оси Z')).toBeVisible();
  await shot(page, 'desktop-section.png');
  const roi = { x: 460, y: 200, width: 500, height: 320 };
  const frame = (await state(page)).renderedFrames;
  await page.locator('#slice-height').evaluate((input, max) => { input.value = String(max); input.dispatchEvent(new Event('input', { bubbles: true })); }, manifest.interiorBounds.max[2]);
  await page.waitForFunction(before => window.__scanTour.getState().renderedFrames > before, frame);
  const full = await page.screenshot({ clip: roi });
  const fixedCamera = (await state(page)).camera.position;
  const lowerFrame = (await state(page)).renderedFrames;
  await page.locator('#slice-height').evaluate((input, min) => { input.value = String(min + 0.3); input.dispatchEvent(new Event('input', { bubbles: true })); }, manifest.interiorBounds.min[2]);
  await page.waitForFunction(before => window.__scanTour.getState().renderedFrames > before, lowerFrame);
  const cut = await page.screenshot({ clip: roi });
  expect(cut.equals(full), 'cut must change actual scene pixels away from labels').toBe(false);
  expect((await state(page)).camera.position).toEqual(fixedCamera);

  await page.getByRole('button', { name: 'Облегчённый' }).click();
  await expect.poll(async () => (await state(page)).renderedPoints).toBeLessThanOrEqual(200000);
  expect((await state(page)).pixelRatio).toBe(1);
  expect((await state(page)).lightMode).toBe(true);
  await page.getByRole('button', { name: '05 Обзор' }).click();
  await waitProgress(page, 1);
  await expect.poll(async () => (await state(page)).renderedPoints).toBe(400000);
  await record('desktop-light-overview-state.json', await state(page));
  expect(await page.evaluate(() => Object.isFrozen(window.__scanTour) && Object.isFrozen(window.__scanTour.getState().camera.position) && !Object.getOwnPropertyDescriptor(window, '__scanTour').writable)).toBe(true);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('390px mobile has 44px targets, capped light mode, reduced motion and working keyboard chapters', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce', baseURL: 'http://127.0.0.1:4178/geonika-scan-prototype/' });
  const page = await context.newPage();
  await page.goto('./');
  await waitReady(page);
  const initial = await state(page);
  await record('mobile-initial-state.json', initial);
  expect(initial.lightMode).toBe(true);
  expect(initial.reducedMotion).toBe(true);
  expect(initial.pixelRatio).toBe(1);
  expect(initial.renderedPoints).toBe(200000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const targets = await page.locator('button:visible, summary:visible').evaluateAll(elements => elements.map(element => ({ name: element.textContent.trim(), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
  for (const target of targets) { expect(target.width, target.name).toBeGreaterThanOrEqual(44); expect(target.height, target.name).toBeGreaterThanOrEqual(44); }
  await shot(page, 'mobile-390-overall.png');
  await page.keyboard.press('End');
  await waitProgress(page, 1);
  await page.keyboard.press('Home');
  await waitProgress(page, 0);
  await page.getByRole('button', { name: '04 Срез' }).tap();
  await waitProgress(page, 0.76);
  await shot(page, 'mobile-390-section.png');
  await page.keyboard.press('f');
  expect((await state(page)).mode).toBe('free');
  const position = (await state(page)).camera.position;
  await page.keyboard.press('ArrowRight');
  expect((await state(page)).camera.position).not.toEqual(position);
  await page.keyboard.press('Escape');
  expect((await state(page)).mode).toBe('route');
  await context.close();
});

test('downloaded exterior is genuinely drawn while interior is held, but readiness stays false', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/data/interior.bin', async route => { await held; await route.continue(); });
  try {
    await page.goto('./');
    await expect.poll(async () => (await state(page)).loadedClouds).toEqual(['exterior']);
    await expect.poll(async () => (await state(page)).renderedPoints).toBeGreaterThan(0);
    const loading = await state(page);
    await record('loading-exterior-state.json', loading);
    expect(loading.ready).toBe(false);
    expect(loading.loadedBytes).toBe(manifest.clouds.find(cloud => cloud.id === 'exterior').byteLength);
    expect(loading.loadedBytes).toBeLessThan(loading.totalBytes);
    await expect(page.locator('#load-status')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Свободный осмотр' })).toBeDisabled();
    await shot(page, 'real-progress-exterior-drawn.png');
    release();
    await waitReady(page);
    expect((await state(page)).loadedClouds).toEqual(['exterior', 'interior']);
  } finally { release(); }
});

test('honest manifest error can retry into actual rendered scan', async ({ page }) => {
  await page.route('**/data/manifest.json', route => route.fulfill({ status: 404, body: 'missing' }), { times: 1 });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Не удалось открыть скан' })).toBeVisible();
  expect((await state(page)).ready).toBe(false);
  expect((await state(page)).renderedPoints).toBe(0);
  await page.getByRole('button', { name: 'Повторить загрузку' }).click();
  await waitReady(page);
  expect((await state(page)).loadedClouds.length).toBe(2);
  expect((await state(page)).renderedPoints).toBeGreaterThan(0);
});

test('WebGL unavailable is a clear fallback, never a ready fake image', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return type.startsWith('webgl') ? null : getContext.call(this, type, ...rest); };
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'WebGL недоступен' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Перезагрузить просмотр' })).toBeVisible();
  const current = await state(page);
  expect(current.ready).toBe(false);
  expect(current.renderedPoints).toBe(0);
  expect(current.loadedClouds).toEqual([]);
});
