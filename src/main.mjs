import './style.css';
import { decodeCloud } from './cloud.mjs';
import { ScanAssets } from './assets.mjs';
import { createRoute, sampleRoute, chapterIndex, progressFromScroll, scrollFromProgress, smoothstep, mixVector } from './route.mjs';
import { createTourState, reduceTour, tickTour, isDisplayReady } from './state.mjs';
import { ScanScene } from './scene.mjs';

const $ = id => document.getElementById(id);
const chapterButtons = Array.from(document.querySelectorAll('[data-chapter]'));
const displayButtons = Array.from(document.querySelectorAll('[data-display]'));
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;
let lightMode = window.matchMedia('(max-width: 600px)').matches || (navigator.deviceMemory && navigator.deviceMemory <= 4);
try { const stored = localStorage.getItem('geonika-light'); if (stored !== null) lightMode = stored === 'true'; } catch { /* private browsing still works */ }
lightMode = Boolean(lightMode);
let state = createTourState();
let scene;
let assets;
let loadingPhase = 'initial';
let manifest;
let route;
let ready = false;
let assetsReady = false;
let loadGeneration = 0;
let abortController;
let returnFrom;
let frozenScroll = 0;
let clipOverride = null;
let activeChapter = -1;
let lastPoseProgress = NaN;
let lastRenderedMode = '';
let reloadRequired = false;
let loadedBytes = 0;
let totalBytes = 0;
let failureMessage = null;

// Read-only QA observation. No mutators, URLs, credentials or private state.
Object.defineProperty(window, '__scanTour', {
  value: Object.freeze({
    getState: () => Object.freeze({
      camera: Object.freeze({
        position: Object.freeze(scene ? scene.camera.position.toArray() : []),
        target: Object.freeze(scene ? scene.controls.target.toArray() : []),
        up: Object.freeze(scene ? scene.camera.up.toArray() : [0, 0, 1]),
      }),
      progress: state.progress, targetProgress: state.targetProgress, mode: state.mode,
      displayMode: state.displayMode, loadingPhase,
      loadedModels: Object.freeze(scene ? [...scene.models.keys()] : []),
      renderedModels: Object.freeze(scene ? [...scene.renderedModels] : []),
      modelCounts: Object.freeze(Object.fromEntries(scene ? [...scene.models].map(([id, value]) => [id, Object.freeze({ vertexCount: value.vertexCount, triangleCount: value.triangleCount })]) : [])),
      // Actual submitted triangles, not points, pixels or clip survivors.
      renderedTriangles: scene && !scene.failed ? scene.renderedTriangles : 0,
      renderedCalls: scene && !scene.failed ? scene.renderedCalls : 0,
      loadedClouds: Object.freeze(scene ? [...scene.clouds.keys()] : []),
      renderedClouds: Object.freeze(scene ? [...scene.renderedClouds] : []),
      cloudPointCounts: Object.freeze(Object.fromEntries(scene ? [...scene.clouds].map(([id, value]) => [id, value.cloud.pointCount]) : [])),
      // Submitted vertices in the last completed WebGL draw, not visible pixels.
      renderedPoints: scene && !scene.failed ? scene.renderedPoints : 0,
      renderedFrames: scene?.renderedFrames ?? 0,
      ready, lightMode, reducedMotion, pixelRatio: scene?.renderer.getPixelRatio() ?? 0,
      loadedBytes, totalBytes, sectionHeight: clipOverride ?? (route ? sampleRoute(route, state.progress).sliceHeight : null),
      error: failureMessage,
    }),
  }),
  configurable: false, writable: false,
});

function announce(message) { $('announcement').textContent = message; }
function setEnabled(enabled) {
  $('mode-button').disabled = !enabled;
  chapterButtons.forEach(button => { button.disabled = !enabled; });
}
function displayUI(busy = false) {
  displayButtons.forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.display === state.displayMode));
    button.disabled = busy || !scene || scene.failed;
  });
  $('scan-canvas').setAttribute('aria-label', state.displayMode === 'surfaces' ? 'Цветная 3D-реконструкция поверхностей здания по реальному скану, не BIM' : 'Реальный 3D-скан здания, облако цветных точек');
}
function qualityUI() { $('quality-button').setAttribute('aria-pressed', String(lightMode)); }
qualityUI();
document.body.classList.add('is-loading');

function showFailure(message, reload = false, unavailable = false) {
  ready = false;
  assetsReady = false;
  failureMessage = message;
  loadingPhase = 'error';
  reloadRequired = reload;
  abortController?.abort();
  if (state.mode === 'free') {
    document.body.classList.remove('is-free');
    scene?.setFree(false);
    state = { ...createTourState(state.progress), displayMode: state.displayMode };
  }
  $('chapter-copy').hidden = true;
  $('load-status').hidden = false;
  $('load-status').setAttribute('aria-busy', 'false');
  $('load-title').textContent = unavailable ? 'WebGL недоступен' : 'Не удалось открыть скан';
  $('load-message').textContent = message;
  $('load-progress').parentElement.hidden = true;
  $('retry-button').hidden = false;
  $('retry-button').textContent = reload ? 'Перезагрузить просмотр ↻' : 'Повторить загрузку ↻';
  $('section-control').hidden = true;
  document.body.classList.remove('is-section');
  setEnabled(false);
  displayUI();
  updateModeUI();
  announce(message);
}

function decodeInWorker(buffer, cloud, signal) {
  if (!window.Worker) return Promise.resolve(decodeCloud(buffer, cloud));
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL('./cloud-worker.mjs', import.meta.url), { type: 'module' }); }
    catch { resolve(decodeCloud(buffer, cloud)); return; }
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(new DOMException('Загрузка отменена.', 'AbortError')); };
    worker.onmessage = event => {
      cleanup();
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.error));
    };
    worker.onerror = () => { cleanup(); reject(new Error('Не удалось обработать облако точек. Перезагрузите страницу.')); };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    worker.postMessage({ buffer, cloud }, [buffer]);
  });
}

function updateProgress(bytes) {
  loadedBytes = bytes;
  const percent = totalBytes > 0 ? Math.floor(bytes / totalBytes * 100) : 0;
  $('load-progress').value = percent;
  $('load-percent').textContent = `${percent}%`;
}

async function loadScan(displayMode = state.displayMode) {
  const generation = ++loadGeneration;
  abortController?.abort();
  abortController = new AbortController();
  const { signal } = abortController;
  ready = false;
  assetsReady = false;
  failureMessage = null;
  reloadRequired = false;
  state = reduceTour(state, { type: 'display', displayMode });
  scene.setDisplayMode(displayMode);
  $('chapter-copy').hidden = true;
  $('load-status').hidden = false;
  $('load-status').setAttribute('aria-busy', 'true');
  $('load-title').textContent = displayMode === 'surfaces' ? 'Открываем поверхности' : 'Открываем точки';
  $('load-message').textContent = 'Читаем манифест измерений…';
  $('load-progress').parentElement.hidden = false;
  $('retry-button').hidden = true;
  $('section-control').hidden = true;
  document.body.classList.add('is-loading');
  totalBytes = 0;
  updateProgress(0);
  setEnabled(false);
  displayUI(true);
  try {
    manifest = await assets.load(displayMode, {
      signal,
      onPhase: (phase, id) => {
        loadingPhase = phase;
        const side = id === 'exterior' ? 'наружную' : 'внутреннюю';
        $('load-message').textContent = phase === 'manifest' ? 'Читаем манифест измерений…' : phase === 'download' ? `Загружаем ${side} часть скана…` : displayMode === 'surfaces' ? 'SHA-256 совпала. Разбираем треугольники GLB…' : 'SHA-256 совпала. Декодируем измеренные точки…';
      },
      onManifest: current => {
        // Keep one route/source frame when comparing displays. Switching a
        // representation never resets scroll, clip height or free-camera pose.
        if (!route) {
          route = createRoute(current.bounds, current.interiorBounds);
          scene.setPose(sampleRoute(route, state.progress));
          $('slice-height').min = String(current.interiorBounds.min[2] + 0.05);
          $('slice-height').max = String(current.interiorBounds.max[2]);
        }
        const surfaces = displayMode === 'surfaces';
        const count = surfaces ? current.models.reduce((sum, item) => sum + item.triangleCount, 0) : current.clouds.reduce((sum, item) => sum + item.pointCount, 0);
        $('point-count').textContent = `${count.toLocaleString('ru-RU')} ${surfaces ? 'треугольников' : 'точек в выборке'}`;
        $('point-count').title = surfaces ? 'Сумма треугольников двух реконструированных моделей; не число видимых пикселей.' : 'Сумма измеренных точек двух подготовленных облаков; не число видимых пикселей.';
      },
      onProgress: (bytes, total) => { totalBytes = total; updateProgress(bytes); },
      onAsset: (meta, value) => displayMode === 'surfaces' ? scene.addSurface(meta, value) : scene.addCloud(meta, value),
    });
    if (generation !== loadGeneration || signal.aborted) return;
    assetsReady = true;
    loadingPhase = 'drawing';
    $('load-message').textContent = 'Обе части проверены. Отрисовываем первый кадр WebGL…';
    scene.dirty = true;
  } catch (error) {
    if (error.name !== 'AbortError' && generation === loadGeneration) showFailure(error.message);
  }
}

function updateModeUI() {
  const free = state.mode === 'free';
  $('mode-button').setAttribute('aria-pressed', String(free));
  $('mode-label').textContent = free ? 'Вернуться к маршруту' : 'Свободный осмотр';
  $('mode-hint').textContent = free ? 'Вращайте · приближайте · исследуйте' : 'Свой ракурс — в любой момент';
  $('scroll-hint').innerHTML = free ? '<span aria-hidden="true">↔</span> Свободный осмотр · Esc — к маршруту' : '<span aria-hidden="true">↓</span> Листайте, чтобы менять ракурс';
}

function enterFree() {
  if (!ready || state.mode === 'free') return;
  state = reduceTour(state, { type: 'free' });
  frozenScroll = scrollFromProgress(state.progress, window.innerHeight, document.documentElement.scrollHeight);
  window.scrollTo({ top: frozenScroll, behavior: 'instant' });
  document.body.classList.add('is-free');
  scene.setFree(true);
  $('scan-canvas').focus({ preventScroll: true });
  updateModeUI();
  announce('Свободный осмотр. Перетаскивайте для вращения, колесо для приближения. Escape возвращает к маршруту.');
}

function returnToRoute() {
  if (!ready || state.mode !== 'free') return;
  scene.setFree(false);
  returnFrom = scene.getPose();
  state = reduceTour(state, { type: 'route', reducedMotion });
  document.body.classList.remove('is-free');
  window.scrollTo({ top: frozenScroll, behavior: 'instant' });
  lastPoseProgress = NaN;
  updateModeUI();
  announce('Управление возвращено маршруту. Листайте страницу или выберите главу.');
}

function goToChapter(index) {
  if (!ready || !route) return;
  const chapter = route.chapters[Math.max(0, Math.min(4, index))];
  if (state.mode === 'free' || state.mode === 'returning') {
    scene.setFree(false);
    returnFrom = scene.getPose();
  }
  state = reduceTour(state, { type: 'chapter', progress: chapter.progress, reducedMotion });
  document.body.classList.remove('is-free');
  window.scrollTo({ top: scrollFromProgress(chapter.progress, window.innerHeight, document.documentElement.scrollHeight), behavior: 'instant' });
  lastPoseProgress = NaN;
  clipOverride = null;
  updateModeUI();
}

function updateChapterUI(pose) {
  if (pose.chapterIndex !== activeChapter) {
    activeChapter = pose.chapterIndex;
    clipOverride = null;
    const chapter = route.chapters[activeChapter];
    $('chapter-eyebrow').textContent = chapter.eyebrow;
    $('chapter-title').textContent = chapter.title;
    $('chapter-description').textContent = chapter.description;
    chapterButtons.forEach((button, index) => {
      if (index === activeChapter) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
  }
  const section = activeChapter === 3 && ready;
  $('section-control').hidden = !section;
  document.body.classList.toggle('is-section', section);
  const height = clipOverride ?? pose.sliceHeight;
  if (section) {
    if (document.activeElement !== $('slice-height')) $('slice-height').value = String(height);
    $('slice-value').value = `${height.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} м`;
    $('slice-height').setAttribute('aria-valuetext', `${height.toFixed(2)} метра по оси Z`);
  }
  const active = state.displayMode === 'surfaces' ? scene.models : scene.clouds;
  $('exterior-indicator').classList.toggle('is-visible', pose.exterior > 0.01 && active.has('exterior'));
  $('interior-indicator').classList.toggle('is-visible', pose.interior > 0.01 && active.has('interior'));
  document.documentElement.style.setProperty('--route-progress', `${pose.progress * 100}%`);
  $('route-percent').textContent = `${Math.round(pose.progress * 100)}%`;
  return height;
}

displayButtons.forEach(button => button.addEventListener('click', () => {
  if (button.dataset.display !== state.displayMode) loadScan(button.dataset.display);
}));
$('mode-button').addEventListener('click', () => state.mode === 'free' ? returnToRoute() : enterFree());
chapterButtons.forEach(button => button.addEventListener('click', () => goToChapter(Number(button.dataset.chapter))));
$('quality-button').addEventListener('click', () => {
  lightMode = !lightMode;
  try { localStorage.setItem('geonika-light', String(lightMode)); } catch { /* optional preference */ }
  qualityUI();
  scene?.setQuality(lightMode);
  announce(lightMode ? 'Облегчённый режим: pixel ratio 1. В режиме точек — не более 200 тысяч на облако. Геометрия поверхностей сохранена.' : 'Полная подготовленная геометрия. Pixel ratio ограничен 1,75.');
});
$('slice-height').addEventListener('input', event => {
  clipOverride = Number(event.target.value);
  scene.dirty = true;
});
$('retry-button').addEventListener('click', () => reloadRequired ? window.location.reload() : loadScan());
window.addEventListener('scroll', () => {
  if (!route || state.mode === 'free') return;
  state = reduceTour(state, { type: 'scroll', progress: progressFromScroll(window.scrollY, window.innerHeight, document.documentElement.scrollHeight) });
}, { passive: true });
window.addEventListener('resize', () => {
  scene?.resize();
  if (state.mode !== 'free') state = reduceTour(state, { type: 'scroll', progress: progressFromScroll(window.scrollY, window.innerHeight, document.documentElement.scrollHeight) });
});
motionQuery.addEventListener('change', event => {
  reducedMotion = event.matches;
  if (scene) {
    scene.reducedMotion = reducedMotion;
    scene.controls.enableDamping = state.mode === 'free' && !reducedMotion;
    scene.dirty = true;
  }
});
document.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key === 'Escape') {
    $('help').open = false;
    if (state.mode === 'free') { event.preventDefault(); returnToRoute(); }
    return;
  }
  if (!ready || event.target.closest('.help')) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); state.mode === 'free' ? returnToRoute() : enterFree(); return; }
  if (state.mode === 'free') {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_'].includes(event.key)) {
      event.preventDefault();
      scene.keyboardOrbit(event.key, event.shiftKey);
    }
    return;
  }
  const current = chapterIndex(route, state.targetProgress);
  const next = { ArrowRight: current + 1, ArrowLeft: current - 1, PageDown: current + 1, PageUp: current - 1, Home: 0, End: 4 }[event.key];
  if (next !== undefined) { event.preventDefault(); goToChapter(next); }
});

let lastTimestamp = 0;
function animate(timestamp) {
  window.requestAnimationFrame(animate);
  const dt = Math.min(0.06, Math.max(0, (timestamp - (lastTimestamp || timestamp)) / 1000));
  lastTimestamp = timestamp;
  if (document.hidden || !scene || scene.failed) return;
  state = tickTour(state, dt, reducedMotion);
  if (route) {
    const pose = sampleRoute(route, state.progress);
    const height = updateChapterUI(pose);
    scene.setCloudState(pose, height);
    if (state.mode === 'returning' && returnFrom) {
      const t = smoothstep(state.returnElapsed / 0.85);
      scene.setPose({ position: mixVector(returnFrom.position, pose.position, t), target: mixVector(returnFrom.target, pose.target, t) });
    } else if (state.mode !== 'free' && (state.progress !== lastPoseProgress || lastRenderedMode !== state.mode)) scene.setPose(pose);
    lastPoseProgress = state.progress;
    lastRenderedMode = state.mode;
  }
  const drewGeometry = scene.render();
  if (!ready && drewGeometry && isDisplayReady(state.displayMode, assetsReady, scene)) {
    // "Ready" is only reported after actual renderer draw counters, never
    // after fetch(), decode, buffer allocation, or a timed loading animation.
    ready = true;
    loadingPhase = 'ready';
    displayUI();
    $('load-status').hidden = true;
    $('load-status').setAttribute('aria-busy', 'false');
    $('chapter-copy').hidden = false;
    document.body.classList.remove('is-loading');
    setEnabled(true);
    announce(state.displayMode === 'surfaces' ? 'Обе модели загружены и проверены. Треугольники поверхностей отрисованы.' : 'Оба облака загружены и проверены. Измеренные точки отрисованы.');
  }
}

try {
  scene = new ScanScene($('scan-canvas'), { lightMode, reducedMotion, onFailure: showFailure });
  assets = new ScanAssets({ dataURL: new URL('data/', new URL(import.meta.env.BASE_URL, document.baseURI)), decodePoints: decodeInWorker });
  history.scrollRestoration = 'manual';
  window.scrollTo({ top: 0, behavior: 'instant' });
  window.requestAnimationFrame(animate);
  loadScan();
} catch {
  showFailure('Для интерактивного скана нужен WebGL 2. Включите аппаратное ускорение или откройте страницу в современном браузере. Данные не подменены картинкой.', true, true);
}
