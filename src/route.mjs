import { validateBounds } from './cloud.mjs';

export const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
export const smoothstep = value => { const t = clamp01(value); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
export const mixVector = (a, b, t) => a.map((value, axis) => mix(value, b[axis], t));

export function createRoute(bounds, interiorBounds) {
  validateBounds(bounds);
  validateBounds(interiorBounds, 'interiorBounds');
  const size = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const inner = interiorBounds.max.map((value, axis) => value - interiorBounds.min[axis]);
  const center = interiorBounds.min.map((value, axis) => value + inner[axis] / 2);
  const [x, y] = center;
  const floor = interiorBounds.min[2];
  const top = interiorBounds.max[2];
  const eye = floor + inner[2] * 0.34;
  const uncut = top + 1;
  // Framing is derived from measured bounds, not a claim of a traversable door.
  // Coordinates remain in the LAS right-handed, Z-up reference frame.
  const chapters = [
    {
      id: 'overall', progress: 0, title: 'Общий вид', eyebrow: '01 / СНАРУЖИ',
      description: 'Поверхности восстановлены по измерениям. Реконструкция из скана, не BIM.',
      position: [x + size[0] * 0.43, y - size[1] * 0.67, top + size[2] * 0.38],
      target: [x, y, eye + 1], exterior: 1, interior: 0, sliceHeight: uncut,
    },
    {
      id: 'facade', progress: 0.24, title: 'Фасад', eyebrow: '02 / ПРИБЛИЖЕНИЕ',
      description: 'Форма и цвет — из реального скана. Переключите на точки, чтобы сравнить с измерениями.',
      position: [x + inner[0] * 0.9, interiorBounds.min[1] - inner[1] * 0.88, eye + inner[2] * 0.62],
      target: [x, y - inner[1] * 0.13, eye], exterior: 1, interior: 0, sliceHeight: uncut,
    },
    {
      id: 'inside', progress: 0.5, title: 'Внутри', eyebrow: '03 / ИНТЕРЬЕР',
      description: 'Внутренний скан в той же системе координат. Геометрия реконструкции может быть неполной.',
      position: interiorBounds.min.map((value, axis) => value + inner[axis] * [0.31, 0.68, 0.225][axis]),
      target: interiorBounds.min.map((value, axis) => value + inner[axis] * [0.68, 0.68, 0.243][axis]),
      exterior: 0, interior: 1, sliceHeight: uncut,
    },
    {
      id: 'section', progress: 0.76, title: 'Срез', eyebrow: '04 / ПО ВЫСОТЕ Z',
      description: 'Геометрия выше отметки Z скрыта. Меняйте высоту среза, чтобы читать пространство.',
      position: [x + inner[0] * 0.95, y - inner[1] * 0.85, top + inner[2] * 1.25],
      target: [x, y, floor + inner[2] * 0.28], exterior: 0, interior: 1,
      sliceHeight: floor + inner[2] * 0.52,
    },
    {
      id: 'overview', progress: 1, title: 'Обзор', eyebrow: '05 / СНАРУЖИ И ВНУТРИ',
      description: 'Снаружи и внутри — вместе. Перейдите к свободному осмотру и выберите свой ракурс.',
      position: [x - inner[0] * 1.55, y - inner[1] * 1.6, top + inner[2] * 1.05],
      target: [x, y, eye + 1], exterior: 1, interior: 1, sliceHeight: uncut,
    },
  ];
  return { bounds, interiorBounds, chapters };
}

export function chapterIndex(route, progress) {
  const p = clamp01(progress);
  let best = 0;
  route.chapters.forEach((chapter, index) => {
    if (Math.abs(chapter.progress - p) < Math.abs(route.chapters[best].progress - p)) best = index;
  });
  return best;
}

export function sampleRoute(route, progress) {
  const p = clamp01(progress);
  const chapters = route.chapters;
  let index = chapters.findIndex((chapter, i) => i < chapters.length - 1 && p <= chapters[i + 1].progress);
  if (index < 0) index = chapters.length - 2;
  const a = chapters[index];
  const b = chapters[index + 1];
  const t = smoothstep((p - a.progress) / (b.progress - a.progress));
  const sliceHeight = mix(a.sliceHeight, b.sliceHeight, t);
  return {
    position: mixVector(a.position, b.position, t),
    target: mixVector(a.target, b.target, t),
    exterior: mix(a.exterior, b.exterior, t), interior: mix(a.interior, b.interior, t),
    sliceHeight, sliceEnabled: sliceHeight < route.interiorBounds.max[2] - 0.001,
    progress: p, chapterIndex: chapterIndex(route, p),
  };
}

export function progressFromScroll(scrollY, viewportHeight, documentHeight) {
  const distance = documentHeight - viewportHeight;
  return distance > 0 ? clamp01(scrollY / distance) : 0;
}

export function scrollFromProgress(progress, viewportHeight, documentHeight) {
  return clamp01(progress) * Math.max(0, documentHeight - viewportHeight);
}
