import test from 'node:test';
import assert from 'node:assert/strict';

let createTourState = () => ({ mode: 'route', progress: 0, targetProgress: 0 });
let reduceTour = state => state;
let tickTour = state => state;
let pointBudget;
let pixelRatio;
try {
  ({ createTourState, reduceTour, tickTour, pointBudget, pixelRatio } = await import('../src/state.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('/src/state.mjs')) throw error;
}

test('free inspection owns camera: scrolling cannot move route until explicit return', () => {
  let state = createTourState(0.5);
  state = reduceTour(state, { type: 'free' });
  assert.equal(state.mode, 'free');
  state = reduceTour(state, { type: 'scroll', progress: 0.9 });
  assert.equal(state.targetProgress, 0.5, 'wheel must belong to OrbitControls, not route');
  state = reduceTour(state, { type: 'route' });
  assert.equal(state.mode, 'returning');
  state = tickTour(state, 1, false);
  assert.equal(state.mode, 'route');
  assert.equal(state.progress, 0.5);
});

test('reduced motion reaches requested chapter in one tick and returns without interpolation', () => {
  let state = createTourState();
  state = reduceTour(state, { type: 'chapter', progress: 0.76, reducedMotion: true });
  state = tickTour(state, 1 / 60, true);
  assert.equal(state.progress, 0.76);
  state = reduceTour(state, { type: 'free' });
  state = reduceTour(state, { type: 'route', reducedMotion: true });
  assert.equal(state.mode, 'route');
});

test('scroll smoothing is frame-rate independent; free state is unchanged by animation ticks', () => {
  const target = reduceTour(createTourState(), { type: 'scroll', progress: 1 });
  const once = tickTour(target, 0.5);
  let many = target;
  for (let i = 0; i < 30; i++) many = tickTour(many, 1 / 60);
  assert.ok(Math.abs(once.progress - many.progress) < 1e-12);
  const free = reduceTour(many, { type: 'free' });
  assert.equal(tickTour(free, 100), free);
});

test('light mode caps measured point budget and pixel ratio without increasing tiny clouds', () => {
  assert.equal(pointBudget(1000000, true), 200000);
  assert.equal(pointBudget(12, true), 12);
  assert.equal(pointBudget(1000000, false), 1000000);
  assert.equal(pointBudget(-1, true), 0);
  assert.equal(pixelRatio(3, false), 1.75);
  assert.equal(pixelRatio(3, true), 1);
  assert.equal(pixelRatio(NaN, false), 1);
});
