import { clamp01 } from './route.mjs';

export function createTourState(progress = 0) {
  const p = clamp01(progress);
  return { mode: 'route', progress: p, targetProgress: p, returnElapsed: 0 };
}

export function reduceTour(state, event) {
  switch (event.type) {
    case 'scroll':
      return state.mode === 'free' ? state : { ...state, targetProgress: clamp01(event.progress) };
    case 'free':
      return state.mode === 'free' ? state : { ...state, mode: 'free', targetProgress: state.progress, returnElapsed: 0 };
    case 'route':
      return state.mode !== 'free' ? state : { ...state, mode: event.reducedMotion ? 'route' : 'returning', returnElapsed: 0 };
    case 'chapter':
      return { ...state, mode: state.mode === 'free' && !event.reducedMotion ? 'returning' : state.mode === 'returning' ? 'returning' : 'route', targetProgress: clamp01(event.progress), returnElapsed: 0 };
    default:
      return state;
  }
}

export function tickTour(state, deltaSeconds, reducedMotion = false) {
  if (state.mode === 'free') return state;
  const dt = Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0);
  const factor = reducedMotion ? 1 : 1 - Math.exp(-9 * dt);
  let progress = state.progress + (state.targetProgress - state.progress) * factor;
  if (Math.abs(progress - state.targetProgress) < 0.00001) progress = state.targetProgress;
  const returnElapsed = state.mode === 'returning' ? state.returnElapsed + dt : 0;
  const mode = state.mode === 'returning' && (reducedMotion || returnElapsed >= 0.85) ? 'route' : state.mode;
  return { ...state, progress, returnElapsed, mode };
}

export function pointBudget(pointCount, lightMode) {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) return 0;
  return lightMode ? Math.min(pointCount, 200000) : pointCount;
}

export function pixelRatio(devicePixelRatio, lightMode) {
  return Math.min(Math.max(Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1, 1), lightMode ? 1 : 1.75);
}
