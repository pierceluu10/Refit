import { useEffect } from 'react';
import type { RefObject } from 'react';

const FRAME_MS = 1000 / 30;

export type Draw = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  seconds: number,
) => void;

// Sizes a canvas to its box at the device's pixel ratio and redraws it about 30 times a second
// while it is on screen and the tab is visible. Under reduced motion it draws one still frame.
export function useCanvasLoop(canvas: RefObject<HTMLCanvasElement | null>, draw: Draw) {
  useEffect(() => {
    const element = canvas.current!;
    const context = element.getContext('2d');
    if (!context) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;
    let onScreen = false;

    const paint = (time: number) => {
      context.clearRect(0, 0, width, height);
      draw(context, width, height, time / 1000);
    };
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      if (time - last < FRAME_MS) return;
      last = time;
      paint(time);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      if (still) paint(0);
      else if (onScreen && !document.hidden) frame = requestAnimationFrame(tick);
    };

    const resizer = new ResizeObserver(([entry]) => {
      const ratio = Math.min(window.devicePixelRatio, 2);
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint(performance.now());
    });
    const watcher = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      update();
    });
    resizer.observe(element);
    watcher.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => {
      cancelAnimationFrame(frame);
      resizer.disconnect();
      watcher.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [canvas, draw]);
}
