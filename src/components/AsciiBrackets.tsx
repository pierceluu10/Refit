import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// Each half of the Refit mark is a 19-unit bracket, 7 units thick, drawn on a
// grid whose cells match a monospace character (0.6em wide, 1.2em tall).
const COLUMNS = 26;
const ROWS = 13;
const THICKNESS = 7 / 19;
const RAMP = ' .:-=+*#%@';
const ENTRANCE_DELAY_MS = 450;
const ENTRANCE_MS = 1000;
const ENTRANCE_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
// Characters flicker until this long before a bracket locks into place.
const SETTLE_MS = 450;
const FLICKER_MS = 45;
// After the intro the brackets stay put, but about two thirds of their characters stay alive: a
// few at a time step to a neighbouring glyph on the ramp (`#` to `%`, `*` to `+`) and back. The
// rest never change, so the mark keeps its shape.
const ALIVE_SHARE = 2 / 3;
const SHIMMER_EVERY_MS = 90;
const SHIMMER_SHARE = 0.08;
const SHIMMER_HOLD_MS = [300, 750] as const;

type Cell = { char: string; reveal: number };
type Point = { x: number; y: number };
type Layout = { start: Point; end: Point; startSlot: Point; endSlot: Point };

function noise(a: number, b: number) {
  return ((((a * 73856093) ^ (b * 19349663)) >>> 0) % 1000) / 1000;
}

function buildStartBracket() {
  const cells: Cell[][] = [];
  for (let row = 0; row < ROWS; row++) {
    const line = [];
    for (let column = 0; column < COLUMNS; column++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const u = (column + (sx + 0.5) / 4) / COLUMNS;
          const v = (row + (sy + 0.5) / 4) / ROWS;
          if (u < THICKNESS || v < THICKNESS) hits++;
        }
      // Cells less than half inside stay blank so the edges are crisp. Shading
      // is densest at the bracket's outer corner.
      const coverage = hits >= 8 ? hits / 16 : 0;
      const depth = (column / COLUMNS + row / ROWS) / 2;
      const level = coverage * (1 - 0.35 * depth) + (noise(column, row) - 0.5) * 0.16;
      const index =
        coverage === 0
          ? 0
          : Math.max(1, Math.min(RAMP.length - 1, Math.round(level * (RAMP.length - 1))));
      line.push({ char: RAMP[index], reveal: depth * 0.7 + noise(row, column) * 0.3 });
    }
    cells.push(line);
  }
  return cells;
}

// The end bracket is the start bracket turned half a turn, cell for cell, so the two mirror
// each other about the headline.
const startCells = buildStartBracket();
const endCells = startCells.map((line) => [...line].reverse()).reverse();

function render(cells: Cell[][], progress: number) {
  return cells
    .map((line) =>
      line
        .map((cell) =>
          cell.char === ' ' || progress >= cell.reveal
            ? cell.char
            : RAMP[1 + Math.floor(Math.random() * (RAMP.length - 1))],
        )
        .join(''),
    )
    .join('\n');
}

const settled = { start: render(startCells, 1), end: render(endCells, 1) };

function move(x: number, y: number) {
  return `translate(${x}px, ${y}px)`;
}

// Places the brackets on opposite corners of the whole headline block (the
// widest line sets the sides), so they mirror each other about its center.
function place(frame: HTMLElement, start: HTMLElement, end: HTMLElement): Layout | null {
  const lines = [...frame.querySelectorAll<HTMLElement>(':scope > :is(h1, h2) > span')];
  if (lines.length === 0 || !document.createRange().getClientRects) return null;
  const box = frame.getBoundingClientRect();
  const range = document.createRange();
  let left = Infinity;
  let right = -Infinity;
  for (const line of lines) {
    range.selectNodeContents(line);
    for (const rect of range.getClientRects()) {
      left = Math.min(left, rect.left - box.left);
      right = Math.max(right, rect.right - box.left);
    }
  }
  if (!Number.isFinite(left)) return null;

  // Vertical edges come from the line boxes, which the headline's entrance
  // transform doesn't move. The top is trimmed to cap height and the bottom
  // to the descenders so the gaps above and below look equal.
  const fontSize = parseFloat(getComputedStyle(lines[0]).fontSize);
  const lastLine = lines[lines.length - 1];
  const top = lines[0].offsetTop + fontSize * 0.14;
  const bottom = lastLine.offsetTop + lastLine.offsetHeight - fontSize * 0.02;
  const size = start.offsetWidth;
  const inner = size * THICKNESS;
  const gap = fontSize * 0.08;

  const layout = {
    start: { x: left - inner - gap, y: top - inner - gap },
    end: { x: right + inner + gap - size, y: bottom + inner + gap - size },
  };
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  start.style.left = `${layout.start.x}px`;
  start.style.top = `${layout.start.y}px`;
  end.style.left = `${layout.end.x}px`;
  end.style.top = `${layout.end.y}px`;

  // Where each bracket sits when the two lock together as the 28-unit mark,
  // centered on the headline.
  const unit = size / 19;
  const markX = center.x - 14 * unit;
  const markY = center.y - 14 * unit;
  return {
    ...layout,
    startSlot: { x: markX, y: markY + unit },
    endSlot: { x: markX + 9 * unit, y: markY + 8 * unit },
  };
}

// The cells of a bracket that shimmer: a fixed two thirds of the drawn ones, chosen by noise so
// the choice is the same on every load.
function aliveCells(cells: Cell[][], salt: number) {
  return cells.flatMap((line, row) =>
    line.flatMap((cell, column) =>
      cell.char !== ' ' && noise(row + salt, column * 7 + 3) < ALIVE_SHARE ? [[row, column]] : [],
    ),
  );
}
const alive = { start: aliveCells(startCells, 11), end: aliveCells(endCells, 29) };

// A bracket with some cells shown as a neighbouring glyph on the ramp.
function renderShimmer(cells: Cell[][], swapped: Map<string, string>) {
  return cells
    .map((line, row) =>
      line.map((cell, column) => swapped.get(`${row}:${column}`) ?? cell.char).join(''),
    )
    .join('\n');
}

function neighbour(char: string) {
  const index = RAMP.indexOf(char);
  const step = index <= 1 ? 1 : index >= RAMP.length - 1 ? -1 : Math.random() < 0.5 ? -1 : 1;
  return RAMP[index + step];
}

// Wraps a headline whose lines are spans. On load the two halves of the Refit mark start
// assembled behind the text, flickering, then glide out to frame it and stay there. Afterwards a
// few of their characters at a time switch to a neighbouring glyph and back, so the mark looks
// alive without moving.
export function AsciiBrackets({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const start = useRef<HTMLPreElement>(null);
  const end = useRef<HTMLPreElement>(null);
  const [text, setText] = useState(settled);

  useLayoutEffect(() => {
    const box = frame.current!;
    const a = start.current!;
    const b = end.current!;
    let layout = place(box, a, b);
    const running: Animation[] = [];
    let request = 0;
    let shimmer = 0;

    const relayout = () => {
      const before = layout;
      layout = place(box, a, b);
      const moved =
        !before ||
        !layout ||
        Math.abs(before.start.x - layout.start.x) +
          Math.abs(before.start.y - layout.start.y) +
          Math.abs(before.end.x - layout.end.x) +
          Math.abs(before.end.y - layout.end.y) >
          0.5;
      if (moved) for (const animation of running.splice(0)) animation.cancel();
    };
    // The headline's box changes when Geist swaps in for the fallback font or
    // the viewport changes its size, so re-measure whenever it does.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(relayout);
    resized?.observe(box);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let visible = true;
    const observer = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting));
    if (layout && !reduced && a.animate) {
      const { start: home, startSlot, endSlot, end: away } = layout;
      const entrance = {
        duration: ENTRANCE_MS,
        delay: ENTRANCE_DELAY_MS,
        easing: ENTRANCE_EASE,
        fill: 'backwards' as const,
      };
      running.push(
        a.animate(
          [
            { transform: move(startSlot.x - home.x, startSlot.y - home.y) },
            { transform: move(0, 0) },
          ],
          entrance,
        ),
        b.animate(
          [{ transform: move(endSlot.x - away.x, endSlot.y - away.y) }, { transform: move(0, 0) }],
          entrance,
        ),
      );

      // Scrambles every character until shortly before the intro ends, then lets them settle
      // into the bracket as it locks into place.
      const duration = ENTRANCE_DELAY_MS + ENTRANCE_MS;
      const began = performance.now();
      let shown = 0;
      const tick = (now: number) => {
        const progress = Math.max(0, now - began - (duration - SETTLE_MS)) / SETTLE_MS;
        if (progress >= 1) return setText(settled);
        if (now - shown >= FLICKER_MS) {
          shown = now;
          setText({ start: render(startCells, progress), end: render(endCells, progress) });
        }
        request = requestAnimationFrame(tick);
      };
      request = requestAnimationFrame(tick);

      // Then the shimmer: each tick some alive cells take a neighbouring glyph for a moment.
      observer.observe(box);
      const swapped = { start: new Map<string, string>(), end: new Map<string, string>() };
      const until = new Map<string, number>();
      shimmer = window.setTimeout(function step() {
        shimmer = window.setTimeout(step, SHIMMER_EVERY_MS);
        if (!visible || document.hidden) return;
        const now = performance.now();
        for (const half of ['start', 'end'] as const) {
          const cells = half === 'start' ? startCells : endCells;
          for (const [key, time] of until)
            if (key.startsWith(half) && time <= now) {
              swapped[half].delete(key.slice(half.length + 1));
              until.delete(key);
            }
          const count = Math.max(1, Math.round(alive[half].length * SHIMMER_SHARE));
          for (let index = 0; index < count; index++) {
            const [row, column] = alive[half][Math.floor(Math.random() * alive[half].length)];
            const key = `${row}:${column}`;
            if (swapped[half].has(key)) continue;
            swapped[half].set(key, neighbour(cells[row][column].char));
            const [shortest, longest] = SHIMMER_HOLD_MS;
            until.set(`${half}:${key}`, now + shortest + Math.random() * (longest - shortest));
          }
        }
        setText({
          start: renderShimmer(startCells, swapped.start),
          end: renderShimmer(endCells, swapped.end),
        });
      }, duration + 300);
    }

    // Cancelling lets a re-run measure the brackets where they actually sit.
    return () => {
      resized?.disconnect();
      observer.disconnect();
      cancelAnimationFrame(request);
      window.clearTimeout(shimmer);
      for (const animation of running) animation.cancel();
    };
  }, []);

  return (
    <div className="ascii-frame" ref={frame}>
      <pre className="ascii-bracket" ref={start} aria-hidden="true">
        {text.start}
      </pre>
      <pre className="ascii-bracket" ref={end} aria-hidden="true">
        {text.end}
      </pre>
      {children}
    </div>
  );
}
