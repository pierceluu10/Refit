// One shared clock for the waitlist page's periodic motion. The workflow
// map's signal runs on every beat; the hero's ASCII mark swaps corners on
// every third, so its spin always lands on one of the Refit node's spins.
export const BEAT_MS = 3000;
export const ASCII_EVERY = 3;
const FIRST_BEAT_MS = 4000;

// Timeline of a beat, in milliseconds from its start. The signal (and, on
// ASCII beats, the brackets) travel in until SPIN_START, both marks spin until
// SPIN_END, and everything lands at SWAP_MS, just before the next beat.
export const SWAP_MS = 2850;
export const SPIN_START_MS = 750;
export const SPIN_END_MS = 2100;
// One and a half turns: the half turn sends each bracket to the other side.
export const SPIN_DEGREES = 540;
export const SPIN_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';

const listeners = new Set<(beat: number) => void>();
let timer = 0;
let count = 0;

function tick() {
  for (const listener of listeners) listener(count);
  count += 1;
  timer = window.setTimeout(tick, BEAT_MS);
}

export function onBeat(listener: (beat: number) => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    count = 0;
    timer = window.setTimeout(tick, FIRST_BEAT_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.clearTimeout(timer);
  };
}
