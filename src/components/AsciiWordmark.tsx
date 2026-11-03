import { useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { MARK_BOX, MARK_PATH } from './Brand';

const RAMP = ' .:-=+*#%@';
// A cell is one monospace character: 0.6em wide, 1em tall at line-height 1.
const CELL_WIDTH = 6;
const CELL_HEIGHT = 10;
const SAMPLE_FONT = '600 200px "Geist Variable"';
const WORD = 'Refit';
const DECODE_MS = 1100;
const FLICKER_MS = 50;
const SHIMMER_EVERY_MS = 110;
const SHIMMER_SHARE = 0.025;
const SHIMMER_HOLD_MS = 600;

function noise(a: number, b: number) {
  return ((((a * 73856093) ^ (b * 19349663)) >>> 0) % 1000) / 1000;
}

// Draws the Refit mark (the favicon's two brackets), optionally followed by the wordmark, then
// samples the ink in each character cell.
function rasterize(columns: number, withWord: boolean) {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  probe.font = SAMPLE_FONT;
  const metrics = probe.measureText(WORD);
  const ascent = metrics.actualBoundingBoxAscent;
  // With the word, the mark is as tall as its tallest letter.
  const mark = withWord ? ascent : 200;
  const markWidth = (mark * MARK_BOX.width) / MARK_BOX.height;
  const gap = mark * 0.32;
  const wordWidth = withWord ? metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight : 0;
  const naturalWidth = markWidth + (withWord ? gap + wordWidth : 0);

  const width = columns * CELL_WIDTH;
  const scale = width / naturalWidth;
  const rows = Math.ceil((mark * scale) / CELL_HEIGHT);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = rows * CELL_HEIGHT;
  const context = canvas.getContext('2d')!;
  context.scale(scale, scale);
  // The baseline sits on the bottom edge of the last row, so the letters end flat on it and the
  // overshoot of round letters, like the bottom of the e, falls outside instead of leaving a
  // stray row of faint glyphs.
  context.translate(0, (rows * CELL_HEIGHT) / scale - mark);
  context.fillStyle = '#000';

  const unit = mark / MARK_BOX.height;
  context.save();
  context.scale(unit, unit);
  context.translate(-MARK_BOX.x, -MARK_BOX.y);
  context.fill(new Path2D(MARK_PATH));
  context.restore();
  if (withWord) {
    context.font = SAMPLE_FONT;
    context.fillText(WORD, markWidth + gap + metrics.actualBoundingBoxLeft, ascent);
  }

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const cells: string[][] = [];
  for (let row = 0; row < rows; row++) {
    const line: string[] = [];
    for (let column = 0; column < columns; column++) {
      let ink = 0;
      for (let y = 0; y < CELL_HEIGHT; y++)
        for (let x = 0; x < CELL_WIDTH; x++)
          ink += pixels[((row * CELL_HEIGHT + y) * canvas.width + column * CELL_WIDTH + x) * 4 + 3];
      const coverage = ink / (CELL_WIDTH * CELL_HEIGHT * 255);
      // Cells under half ink stay blank, so edges are crisp rather than frayed. The rest shade
      // from the top left to the bottom right so the letters read as carved, with edge cells a
      // step lighter than solid ones.
      const depth = (column / columns + row / rows) / 2;
      const level = 0.45 + 0.55 * coverage * (1 - 0.3 * depth) + (noise(column, row) - 0.5) * 0.12;
      line.push(
        coverage < 0.45
          ? ' '
          : RAMP[Math.max(6, Math.min(RAMP.length - 1, Math.round(level * (RAMP.length - 1))))],
      );
    }
    cells.push(line);
  }
  // Moving the baseline down can leave the top row under the threshold, and so empty.
  const blank = (line: string[]) => line.every((char) => char === ' ');
  while (cells.length > 1 && blank(cells[0])) cells.shift();
  while (cells.length > 1 && blank(cells[cells.length - 1])) cells.pop();
  return cells;
}

function join(cells: string[][]) {
  return cells.map((line) => line.join('')).join('\n');
}

function neighbour(char: string) {
  const index = RAMP.indexOf(char);
  const step = index <= 1 ? 1 : index >= RAMP.length - 1 ? -1 : Math.random() < 0.5 ? -1 : 1;
  return RAMP[index + step];
}

// The Refit logo drawn in ASCII from the real Geist wordmark. It decodes from noise when it first
// scrolls into view, a few characters keep stepping to a neighbouring glyph, and on a fine pointer
// a lens in the accent color follows the cursor across it. `glint` also sweeps a band of that
// color across it on a loop. `columns` sets the resolution; CSS sets the size.
export function AsciiWordmark({
  columns,
  word = true,
  glint = false,
  className = '',
}: {
  columns: number;
  word?: boolean;
  glint?: boolean;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLPreElement>(null);
  const lens = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let frame = 0;
    let shimmer = 0;
    let cancelled = false;
    let visible = false;
    let settled: string[][] | null = null;
    let begun = false;

    const show = (text: string) => {
      base.current!.textContent = text;
      lens.current!.textContent = text;
    };

    const begin = (cells: string[][]) => {
      begun = true;
      // Decode: each cell scrambles until a sweep from the left passes it.
      const began = performance.now();
      let shown = 0;
      const decode = (now: number) => {
        const progress = (now - began) / DECODE_MS;
        if (progress >= 1) return show(join(cells));
        if (now - shown >= FLICKER_MS) {
          shown = now;
          show(
            join(
              cells.map((line, row) =>
                line.map((char, column) =>
                  char === ' ' || column / line.length + noise(row, column) * 0.25 < progress
                    ? char
                    : RAMP[1 + Math.floor(Math.random() * (RAMP.length - 1))],
                ),
              ),
            ),
          );
        }
        frame = requestAnimationFrame(decode);
      };
      frame = requestAnimationFrame(decode);

      const drawn = cells.flatMap((line, row) =>
        line.flatMap((char, column) => (char === ' ' ? [] : [[row, column] as const])),
      );
      const swapped = new Map<string, { char: string; until: number }>();
      shimmer = window.setTimeout(function step() {
        shimmer = window.setTimeout(step, SHIMMER_EVERY_MS);
        if (!visible || document.hidden) return;
        const now = performance.now();
        for (const [key, swap] of swapped) if (swap.until <= now) swapped.delete(key);
        for (let index = 0; index < Math.ceil(drawn.length * SHIMMER_SHARE); index++) {
          const [row, column] = drawn[Math.floor(Math.random() * drawn.length)];
          swapped.set(`${row}:${column}`, {
            char: neighbour(cells[row][column]),
            until: now + SHIMMER_HOLD_MS * (0.5 + Math.random()),
          });
        }
        show(
          join(
            cells.map((line, row) =>
              line.map((char, column) => swapped.get(`${row}:${column}`)?.char ?? char),
            ),
          ),
        );
      }, DECODE_MS + 200);
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && settled && !begun) begin(settled);
    });

    const start = () => {
      if (cancelled) return;
      settled = rasterize(columns, word);
      if (!settled) return;
      root.current!.style.setProperty('--rows', String(settled.length));
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return show(join(settled));
      // Blank cells hold the logo's size until it first scrolls into view, then it decodes.
      show(join(settled.map((line) => line.map(() => ' '))));
      observer.observe(root.current!);
    };

    // The sample needs Geist itself, not the fallback font. jsdom has no font loading.
    document.fonts?.load(SAMPLE_FONT).then(start, start);
    return () => {
      cancelled = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(shimmer);
    };
  }, [columns, word]);

  function track(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse') return;
    const box = event.currentTarget.getBoundingClientRect();
    lens.current!.style.setProperty('--x', `${event.clientX - box.left}px`);
    lens.current!.style.setProperty('--y', `${event.clientY - box.top}px`);
  }

  return (
    <div
      ref={root}
      className={`ascii-wordmark ${glint ? 'ascii-wordmark-glint' : ''} ${className}`}
      style={{ '--columns': columns } as CSSProperties}
      role="img"
      aria-label="Refit"
      onPointerMove={track}
    >
      <pre ref={base} aria-hidden="true" />
      <pre ref={lens} className="ascii-wordmark-lens" aria-hidden="true" />
    </div>
  );
}
