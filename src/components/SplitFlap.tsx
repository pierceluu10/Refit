import { useEffect, useRef } from 'react';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const FLIP_MS = 70;
// Flips before the first tile lands; each tile after it flips once more, so they land in order.
const FLIPS = 5;
const FLIP_FRAMES: Keyframe[] = [
  { transform: 'rotateX(-75deg)', opacity: 0.4 },
  { transform: 'none', opacity: 1 },
];

// Text on split-flap tiles, like a departure board. The tiles start blank and flip through
// random characters into place when the text scrolls a third of the way up the screen. Reduced
// motion shows the text at once.
export function SplitFlap({ text, className = '' }: { text: string; className?: string }) {
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const tiles = [...root.current!.querySelectorAll<HTMLElement>('.flap-char')];
    const chars = [...text];
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      tiles.forEach((tile, index) => (tile.textContent = chars[index]));
      return;
    }
    let timer = 0;
    const run = () => {
      let tick = 0;
      timer = window.setInterval(() => {
        tick++;
        tiles.forEach((tile, index) => {
          const landing = FLIPS + index;
          if (chars[index] === ' ' || tick > landing) return;
          tile.textContent =
            tick === landing ? chars[index] : CHARSET[Math.floor(Math.random() * CHARSET.length)];
          tile.animate(FLIP_FRAMES, { duration: FLIP_MS, easing: 'ease-out' });
        });
        if (tick >= FLIPS + tiles.length) window.clearInterval(timer);
      }, FLIP_MS);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        run();
      },
      { rootMargin: '0px 0px -33% 0px' },
    );
    observer.observe(root.current!);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [text]);

  return (
    <span ref={root} className={`split-flap ${className}`}>
      <span className="sr-only">{text}</span>
      {[...text].map((char, index) => (
        <span
          key={index}
          className="flap"
          data-blank={char === ' ' || undefined}
          aria-hidden="true"
        >
          <span className="flap-char" />
        </span>
      ))}
    </span>
  );
}
