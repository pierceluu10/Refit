import { useRef } from 'react';
import { useCanvasLoop } from './useCanvasLoop';
import type { Draw } from './useCanvasLoop';

// World units: the plane spans COLUMNS dots either side of the centre, ROWS deep.
const COLUMNS = 34;
const ROWS = 30;
const SPACING = 1;
// Dots sit closer across the plane than along it, so the rows read as lines running away.
const COLUMN_SPACING = 0.5;
const NEAR = 1.2;
const FOCAL = 0.9;
// How far below the horizon the eye sits, as a fraction of the canvas height.
const EYE_HEIGHT = 0.95;
// Rows per second the plane drifts toward the viewer.
const SPEED = 0.35;
const INK = '120, 136, 164';
const BLUE = '0, 72, 216';

// A plane of dots running back to a horizon near the top of the canvas, drifting slowly toward
// the viewer. Dots near the centre line turn blue, as if the demo above them lit the plane.
const draw: Draw = (context, width, height, seconds) => {
  const horizon = height * 0.08;
  const scale = width / 14;
  const shift = (seconds * SPEED) % SPACING;
  for (let row = 0; row < ROWS; row++) {
    const depth = NEAR + row * SPACING - shift;
    const fade = Math.min(1, (ROWS - row) / 8) * Math.min(1, depth - NEAR + 0.3);
    const y = horizon + (EYE_HEIGHT * height * FOCAL) / depth;
    if (y > height + 4) continue;
    for (let column = -COLUMNS * 2; column <= COLUMNS * 2; column++) {
      const x = width / 2 + ((column * COLUMN_SPACING) / depth) * scale;
      if (x < -4 || x > width + 4) continue;
      const centre = Math.exp(-((column / 14) ** 2));
      const radius = Math.max(0.7, 3.2 / depth);
      context.fillStyle = `rgba(${centre > 0.3 ? BLUE : INK}, ${(0.32 + centre * 0.6) * fade})`;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
  }
};

export function DotHorizon({ className = '' }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useCanvasLoop(canvas, draw);
  return <canvas ref={canvas} className={className} aria-hidden="true" />;
}
