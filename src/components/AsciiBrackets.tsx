import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ASCII_EVERY,
  onBeat,
  SPIN_DEGREES,
  SPIN_EASE,
  SPIN_END_MS,
  SPIN_START_MS,
  SWAP_MS,
} from '../beat';

// Each half of the Refit mark is a 19-unit bracket, 7 units thick, drawn on a
// grid whose cells match a monospace character (0.6em wide, 1.2em tall).
const COLUMNS = 26;
const ROWS = 13;
const THICKNESS = 7 / 19;
const RAMP = ' .:-=+*#%@';
const ENTRANCE_DELAY_MS = 450;
const ENTRANCE_MS = 1000;
// Where on screen (as a share of its height) the headline's middle must rise
// to for the scroll-linked reveal to finish.
const REVEAL_DONE = 0.55;
// Share of the swap spent flying in, spinning, and flying out.
const MEET = SPIN_START_MS / SWAP_MS;
const DEPART = SPIN_END_MS / SWAP_MS;
const SPIN_STEPS = 84;
// Characters flicker until this long before a bracket locks into place.
const SETTLE_MS = 450;
const FLICKER_MS = 45;
const EASE = SPIN_EASE;

type Cell = { char: string; reveal: number };
type Point = { x: number; y: number };
type Layout = { start: Point; end: Point; startSlot: Point; endSlot: Point; center: Point };

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

// The end bracket is the start bracket turned half a turn, cell for cell, so a
// bracket that spins across the headline lands looking like the other one.
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

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function move(x: number, y: number, turn = 0) {
  return `translate(${x}px, ${y}px) rotate(${turn}deg)`;
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
    center: { x: (left + right) / 2, y: (top + bottom) / 2 },
  };
  start.style.left = `${layout.start.x}px`;
  start.style.top = `${layout.start.y}px`;
  end.style.left = `${layout.end.x}px`;
  end.style.top = `${layout.end.y}px`;

  // Where each bracket sits when the two lock together as the 28-unit mark,
  // centered on the headline.
  const unit = size / 19;
  const markX = layout.center.x - 14 * unit;
  const markY = layout.center.y - 14 * unit;
  return {
    ...layout,
    startSlot: { x: markX, y: markY + unit },
    endSlot: { x: markX + 9 * unit, y: markY + 8 * unit },
  };
}

// Flies a bracket into its slot in the assembled mark, spins the whole mark
// about its center, then flies out to the opposite corner.
function swapFrames(home: Point, slot: Point, away: Point, center: Point, size: number) {
  const half = size / 2;
  const frames: Keyframe[] = [{ offset: 0, transform: move(0, 0), easing: EASE }];
  for (let step = 0; step <= SPIN_STEPS; step++) {
    const turn = SPIN_DEGREES * easeInOut(step / SPIN_STEPS);
    const radians = (turn * Math.PI) / 180;
    const dx = slot.x + half - center.x;
    const dy = slot.y + half - center.y;
    const x = center.x + dx * Math.cos(radians) - dy * Math.sin(radians) - half;
    const y = center.y + dx * Math.sin(radians) + dy * Math.cos(radians) - half;
    frames.push({
      offset: MEET + ((DEPART - MEET) * step) / SPIN_STEPS,
      transform: move(x - home.x, y - home.y, turn),
      easing: step === SPIN_STEPS ? EASE : 'linear',
    });
  }
  frames.push({ offset: 1, transform: move(away.x - home.x, away.y - home.y, SPIN_DEGREES) });
  return frames;
}

// Wraps a headline whose lines are spans. In the hero ("intro"), the two
// halves start assembled as the Refit mark behind the text on load, flickering,
// then glide out to frame it; every third beat they meet in the middle, spin
// with the workflow map's Refit node, and trade corners. Elsewhere ("reveal"),
// scrolling the headline into view flies them in from the top-left and
// bottom-right corners of its section, and scrolling back up sends them away.
export function AsciiBrackets({
  children,
  mode = 'intro',
}: {
  children: ReactNode;
  mode?: 'intro' | 'reveal';
}) {
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
    let stopBeat = () => {};
    let visible = true;
    const observer = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting));
    let stopScroll = () => {};
    const canAnimate = layout && !reduced && a.animate;
    // Scrambles every character until shortly before `duration` ends, then
    // lets them settle into the bracket as it locks into place.
    const flicker = (duration: number) => {
      cancelAnimationFrame(request);
      const began = performance.now();
      let shown = 0;
      const tick = (now: number) => {
        const elapsed = now - began;
        const progress = Math.max(0, elapsed - (duration - SETTLE_MS)) / SETTLE_MS;
        if (progress >= 1) return setText(settled);
        if (now - shown >= FLICKER_MS) {
          shown = now;
          setText({ start: render(startCells, progress), end: render(endCells, progress) });
        }
        request = requestAnimationFrame(tick);
      };
      request = requestAnimationFrame(tick);
    };

    if (canAnimate && mode === 'reveal') {
      // Tied to scroll, so it plays backwards on the way up. Nothing has
      // started while the headline's middle is below the screen; the brackets
      // are locked in once it rises past REVEAL_DONE of the screen height.
      let frameRequest = 0;
      let shown = 0;
      const update = () => {
        frameRequest = 0;
        if (!layout) return;
        const rect = box.getBoundingClientRect();
        const height = window.innerHeight;
        const middle = rect.top + rect.height / 2;
        const progress = Math.min(1, Math.max(0, (height - middle) / (height * (1 - REVEAL_DONE))));
        const eased = 1 - (1 - progress) ** 3;
        const size = a.offsetWidth;
        // Each bracket starts tucked into its corner of the surrounding section.
        const section = (box.closest('section') ?? box.parentElement!).getBoundingClientRect();
        const startX = section.left - (rect.left + layout.start.x);
        const startY = section.top - (rect.top + layout.start.y);
        const endX = section.right - (rect.left + layout.end.x + size);
        const endY = section.bottom - (rect.top + layout.end.y + size);
        a.style.transform = move(startX * (1 - eased), startY * (1 - eased));
        b.style.transform = move(endX * (1 - eased), endY * (1 - eased));
        // They start faint and reach full black as they lock.
        a.style.opacity = b.style.opacity = String(0.15 + 0.85 * eased);
        // Characters flicker while the brackets move and settle as they lock.
        const now = performance.now();
        if (progress >= 1) setText(settled);
        else if (now - shown >= FLICKER_MS) {
          shown = now;
          setText({ start: render(startCells, progress), end: render(endCells, progress) });
        }
      };
      const schedule = () => {
        if (!frameRequest) frameRequest = requestAnimationFrame(update);
      };
      update();
      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);
      stopScroll = () => {
        cancelAnimationFrame(frameRequest);
        window.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
        a.style.transform = '';
        b.style.transform = '';
        a.style.opacity = '';
        b.style.opacity = '';
      };
    }

    if (canAnimate && mode === 'intro') {
      const { start: home, startSlot, endSlot, end: away } = layout!;
      const entrance = {
        duration: ENTRANCE_MS,
        delay: ENTRANCE_DELAY_MS,
        easing: EASE,
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
      flicker(ENTRANCE_DELAY_MS + ENTRANCE_MS);

      observer.observe(box);
      stopBeat = onBeat((beat) => {
        if (beat % ASCII_EVERY !== 0 || !visible || document.hidden || !layout) return;
        const size = a.offsetWidth;
        const { start, end, startSlot, endSlot, center } = layout;
        running.push(
          a.animate(swapFrames(start, startSlot, end, center, size), { duration: SWAP_MS }),
          b.animate(swapFrames(end, endSlot, start, center, size), { duration: SWAP_MS }),
        );
        flicker(SWAP_MS);
      });
    }

    // Cancelling lets a re-run measure the brackets where they actually sit.
    return () => {
      resized?.disconnect();
      stopScroll();
      stopBeat();
      observer.disconnect();
      cancelAnimationFrame(request);
      for (const animation of running) animation.cancel();
    };
  }, [mode]);

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
