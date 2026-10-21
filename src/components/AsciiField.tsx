import { useEffect, useRef } from 'react';

const CELL = 16;
const FONT = '500 11px "Geist Mono Variable", monospace';
const GLYPHS = ['.', ':', '+', 'o', '*'];
const FRAME_MS = 1000 / 24;
// Streams fade out this close to anything marked `data-field-avoid`, so text stays clean.
const CLEARANCE = 44;
const LENS_RADIUS = 150;
const BASE = '146, 162, 190';
const ACCENT = '0, 72, 216';

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

// How strongly a cell belongs to a stream at time `t` (seconds), from 0 to 1. Streams run
// diagonally down from the upper corners and drift slowly along their own direction.
function density(column: number, row: number, columns: number, rows: number, t: number) {
  const x = column / columns;
  const y = row / rows;
  const warp = noise(column * 0.12 + t * 0.05, row * 0.12) * 2.4;
  const left = Math.sin((x * 1.1 + y * 0.9) * 9 - t * 0.35 + warp);
  const right = Math.sin(((1 - x) * 1.2 + y * 0.8) * 8 - t * 0.3 + warp + 1.7);
  const stream = Math.max(
    smoothstep(0.3, 1, left) * (1.15 - x),
    smoothstep(0.35, 1, right) * (x + 0.15),
  );
  return Math.min(1, stream) * (1 - smoothstep(0.7, 1, y));
}

// A field of ASCII glyphs behind the hero, in the spirit of a plotter's dot screen: diagonal
// streams of characters flow in from the upper corners, part around the elements in the same
// container marked `data-field-avoid`, twinkle, and turn blue around a fine pointer. Decorative;
// it pauses offscreen and holds still under reduced motion.
export function AsciiField() {
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
    let visible = true;

    const resize = () => {
      const box = element.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      size = { width: box.width, height: box.height };
      element.width = Math.round(box.width * ratio);
      element.height = Math.round(box.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.font = FONT;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
    };

    const draw = (t: number) => {
      const { width, height } = size;
      context.clearRect(0, 0, width, height);
      const columns = Math.ceil(width / CELL);
      const rows = Math.ceil(height / CELL);
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
          const cy = row * CELL + CELL / 2;
          let gap = Infinity;
          for (const box of avoid) {
            const dx = Math.max(box.left - cx, 0, cx - box.right);
            const dy = Math.max(box.top - cy, 0, cy - box.bottom);
            gap = Math.min(gap, Math.hypot(dx, dy));
          }
          const mask = smoothstep(0, CLEARANCE, gap);
          let level = density(column, row, columns, rows, t) * mask;
          // Dither: a cell shows only when its level clears its own threshold, so streams
          // break up into scattered glyphs at their edges.
          const threshold = hash(column + 17, row + 31);
          const lens = Math.max(0, 1 - Math.hypot(cx - pointer.x, cy - pointer.y) / LENS_RADIUS);
          level = Math.min(1, level + lens * 0.35 * mask);
          if (level < threshold * 0.55 + 0.08) continue;
          const twinkle = 0.65 + 0.35 * Math.sin(t * 1.6 + threshold * 40);
          const glyph = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(level * GLYPHS.length))];
          const accent = threshold > 0.93 || lens > 0.2;
          const alpha = (accent ? 0.55 : 0.5) * twinkle * Math.min(1, level * 1.6 + lens);
          context.fillStyle = `rgba(${accent ? ACCENT : BASE}, ${alpha.toFixed(3)})`;
          context.fillText(glyph, cx, cy);
        }
      }
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!visible || document.hidden || now - last < FRAME_MS) return;
      last = now;
      draw(now / 1000);
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
    if (reduced) {
      draw(0);
      return () => resized.disconnect();
    }
    const observer = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting));
    observer.observe(element);
    window.addEventListener('pointermove', track, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      resized.disconnect();
      observer.disconnect();
      window.removeEventListener('pointermove', track);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={canvas} className="ascii-field" aria-hidden="true" />;
}
