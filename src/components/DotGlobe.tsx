import { useRef } from 'react';
import { useCanvasLoop } from './useCanvasLoop';
import type { Draw } from './useCanvasLoop';

const POINTS = 900;
// Every HIT_EVERY-th point is a call site: it pulses blue.
const HIT_EVERY = 37;
const TILT = 0.38;
// Radians per second.
const SPIN = 0.12;
const INK = '120, 136, 164';
const BLUE = '0, 72, 216';

// Points spread evenly over a sphere (a Fibonacci lattice), computed once.
const sphere = Array.from({ length: POINTS }, (_, index) => {
  const y = 1 - (2 * (index + 0.5)) / POINTS;
  const ring = Math.sqrt(1 - y * y);
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  return { x: Math.cos(angle) * ring, y, z: Math.sin(angle) * ring, hit: index % HIT_EVERY === 0 };
});

// A slowly turning globe of dots, tilted toward the viewer. The far side fades; scattered call
// sites pulse blue as they come round.
const draw: Draw = (context, width, height, seconds) => {
  const radius = Math.min(width, height) * 0.46;
  const spin = seconds * SPIN;
  const [sin, cos] = [Math.sin(spin), Math.cos(spin)];
  const [tiltSin, tiltCos] = [Math.sin(TILT), Math.cos(TILT)];
  for (const point of sphere) {
    const x = point.x * cos - point.z * sin;
    const turned = point.x * sin + point.z * cos;
    const y = point.y * tiltCos - turned * tiltSin;
    const z = point.y * tiltSin + turned * tiltCos;
    const near = (z + 1) / 2;
    const pulse = point.hit ? 0.5 + 0.5 * Math.sin(seconds * 2 + point.y * 9) : 0;
    context.fillStyle = point.hit
      ? `rgba(${BLUE}, ${(0.35 + pulse * 0.6) * near})`
      : `rgba(${INK}, ${0.08 + near * 0.4})`;
    context.beginPath();
    context.arc(
      width / 2 + x * radius,
      height / 2 + y * radius,
      (point.hit ? 1.6 + pulse * 1.4 : 0.8 + near * 0.9) * (radius / 260),
      0,
      Math.PI * 2,
    );
    context.fill();
  }
};

export function DotGlobe({ className = '' }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useCanvasLoop(canvas, draw);
  return <canvas ref={canvas} className={className} aria-hidden="true" />;
}
