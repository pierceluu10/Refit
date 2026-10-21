// The clock for the workflow map's signal, which runs on every beat, back to back.
export const BEAT_MS = 3000;
const FIRST_BEAT_MS = 4000;

// Timeline of a beat, in milliseconds from its start. The signal reaches the Refit node at
// SPIN_START, the node glows until SPIN_END, and the signal lands at SWAP_MS, just before the
// next beat.
export const SWAP_MS = 2850;
export const SPIN_START_MS = 750;
export const SPIN_END_MS = 2100;

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
