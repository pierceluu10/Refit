import { useEffect, useRef } from 'react';

const CELL = 14;
const FRAME_MS = 1000 / 24;
// Dot radius by density, lightest first; the third size is drawn as a ring.
const RADII = [0.9, 1.3, 2, 2.2];
const RING = 2;
// Rows the stream pattern spans before it repeats down the page, about one screen.
const ROW_SPAN = 56;
// The level every cell has outside a stream, so a sparse dusting covers the whole page.
const DUST = 0.12;
// Streams thin out from FADE_END down to nothing at FADE_START pixels from anything marked
// `data-field-avoid`, along an edge roughened by up to FADE_JITTER pixels so it never runs straight.
const FADE_START = 8;
const FADE_END = 120;
const FADE_JITTER = 56;
const LENS_RADIUS = 150;
const BASE = '160, 174, 198';
const TINT = '96, 140, 230';
const ACCENT = '0, 72, 216';
const OPACITY = 0.5;

function hash(x: number, y: number) {
  return ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 10007) / 10007;
}

// Smooth value noise on the cell grid, so the streams have ragged, organic edges.
function noise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * sx;
  const bottom = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

function smoothstep(from: number, to: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

// How strongly a cell belongs to a stream at time `t` (seconds), from 0 to 1. `row` counts from
// the top of the page. Two sets of streams cross diagonally and drift along their own direction.
function density(column: number, row: number, columns: number, t: number) {
  const x = column / columns;
  const y = row / ROW_SPAN;
  const warp = noise(column * 0.12 + t * 0.05, row * 0.12) * 2.4;
  const left = Math.sin((x * 1.1 + y * 0.9) * 9 - t * 0.35 + warp);
  const right = Math.sin(((1 - x) * 1.2 + y * 0.8) * 8 - t * 0.3 + warp + 1.7);
  return Math.max(smoothstep(0.2, 1, left), smoothstep(0.25, 1, right), DUST);
}

// A dot screen behind the page: diagonal streams of dots and rings fade out around the elements
// in the same container marked `data-field-avoid`, twinkle, and turn blue around a fine pointer.
// The canvas is fixed to the viewport but its cells are anchored to the page, so the field
// scrolls with the content. Decorative; it holds still under reduced motion.
export function ParticleField() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current!;
    const context = element.getContext('2d');
    if (!context) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pointer = { x: -1e4, y: -1e4 };
    let size = { width: 0, height: 0 };
    let frame = 0;
    let last = 0;
    let scrolled = false;

    const resize = () => {
      const box = element.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      size = { width: box.width, height: box.height };
      element.width = Math.round(box.width * ratio);
      element.height = Math.round(box.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.lineWidth = 1;
    };

    const draw = (t: number) => {
      const { width, height } = size;
      context.clearRect(0, 0, width, height);
      const columns = Math.ceil(width / CELL);
      const rows = Math.ceil(height / CELL) + 1;
      const offset = window.scrollY % CELL;
      const first = Math.floor(window.scrollY / CELL);
      const origin = element.getBoundingClientRect();
      const avoid = [
        ...element.parentElement!.querySelectorAll<HTMLElement>('[data-field-avoid]'),
      ].map((target) => {
        const box = target.getBoundingClientRect();
        return {
          left: box.left - origin.left,
          right: box.right - origin.left,
          top: box.top - origin.top,
          bottom: box.bottom - origin.top,
        };
      });
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const cx = column * CELL + CELL / 2;
          const cy = row * CELL - offset + CELL / 2;
          const page = first + row;
          let gap = Infinity;
          for (const box of avoid) {
            const dx = Math.max(box.left - cx, 0, cx - box.right);
            const dy = Math.max(box.top - cy, 0, cy - box.bottom);
            gap = Math.min(gap, Math.hypot(dx, dy));
          }
          const jitter = (noise(column * 0.35, page * 0.35) - 0.5) * FADE_JITTER;
          const mask = smoothstep(FADE_START, FADE_END, gap + jitter);
          let level = density(column, page, columns, t) * mask;
          // Dither: a cell shows only when its level clears its own threshold, so streams
          // break up into scattered glyphs at their edges.
          const threshold = hash(column + 17, page + 31);
          const lens = Math.max(0, 1 - Math.hypot(cx - pointer.x, cy - pointer.y) / LENS_RADIUS);
          level = Math.min(1, level + lens * 0.35 * mask);
          if (level < threshold * 0.55 + 0.08) continue;
          const twinkle = 0.65 + 0.35 * Math.sin(t * 1.6 + threshold * 40);
          const size = Math.min(RADII.length - 1, Math.floor(level * RADII.length));
          const color =
            threshold > 0.97 || lens > 0.4 ? ACCENT : threshold > 0.88 || lens > 0.15 ? TINT : BASE;
          const alpha = OPACITY * twinkle * Math.min(1, level * 1.6 + lens);
          context.beginPath();
          context.arc(cx, cy, RADII[size], 0, Math.PI * 2);
          if (size === RING) {
            context.strokeStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
            context.stroke();
          } else {
            context.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
            context.fill();
          }
        }
      }
    };

    // Scrolling redraws on the next frame, so the dots move in step with the content.
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (document.hidden || (!scrolled && now - last < FRAME_MS)) return;
      last = now;
      scrolled = false;
      draw(now / 1000);
    };
    const scroll = () => {
      if (reduced) draw(0);
      else scrolled = true;
    };

    const track = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const box = element.getBoundingClientRect();
      pointer.x = event.clientX - box.left;
      pointer.y = event.clientY - box.top;
    };

    resize();
    const resized = new ResizeObserver(() => {
      resize();
      if (reduced) draw(0);
    });
    resized.observe(element);
    window.addEventListener('scroll', scroll, { passive: true });
    if (reduced) {
      draw(0);
      return () => {
        resized.disconnect();
        window.removeEventListener('scroll', scroll);
      };
    }
    window.addEventListener('pointermove', track, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      resized.disconnect();
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('pointermove', track);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={canvas} className="particle-field" aria-hidden="true" />;
}
