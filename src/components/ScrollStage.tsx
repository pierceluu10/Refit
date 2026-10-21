import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

// How far the page scrolls while the stage plays, as a share of the screen height.
const TRAVEL = 1;
// The preview's size when it finishes, capped so it fits the screen.
const END_SCALE = 1.2;
const START_SCALE = 0.86;
// One scroll gesture plays the whole rise (or fall) over this long.
const PLAY_MS = 1100;
// Trackpads keep sending wheel events after a flick; ignore them this long after a play ends.
const SETTLE_MS = 350;
// Only where the hero fits one screen; elsewhere the preview sits below it in normal flow.
const STAGE_QUERY =
  '(min-width: 900px) and (min-height: 640px) and (prefers-reduced-motion: no-preference)';
const DOWN_KEYS = new Set(['ArrowDown', 'PageDown', 'End', ' ']);
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// Pins the hero and lifts the preview over it. Any downward scroll, light or hard, plays the whole
// rise: the preview comes up from under the hero and grows past its normal size while the hero
// fades back. Any upward scroll from the end plays it back. The look is still tied to the scroll
// position, so dragging the scrollbar scrubs it.
export function ScrollStage({
  hero,
  preview,
  cue,
}: {
  hero: ReactNode;
  preview: ReactNode;
  cue?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const heroLayer = useRef<HTMLDivElement>(null);
  const previewLayer = useRef<HTMLDivElement>(null);
  const cueLayer = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = stage.current!;
    const back = heroLayer.current!;
    const front = previewLayer.current!;
    const hint = cueLayer.current;
    const query = window.matchMedia(STAGE_QUERY);
    let request = 0;
    let playing = 0;
    let quietUntil = 0;
    const clear = () => {
      for (const element of [back, front, hint]) {
        if (!element) continue;
        element.style.transform = '';
        element.style.opacity = '';
      }
    };
    const travel = () => root.offsetHeight - window.innerHeight;
    const update = () => {
      request = 0;
      if (!query.matches) return clear();
      const height = window.innerHeight;
      const width = window.innerWidth;
      const distance = travel();
      const progress =
        distance > 0 ? Math.min(1, Math.max(0, -root.getBoundingClientRect().top / distance)) : 1;
      // Measured without the transform, so the start and end do not depend on the last frame.
      const previewHeight = front.offsetHeight;
      const previewWidth = front.offsetWidth;
      // It starts just below the screen; the cue says it is there.
      const startTop = height;
      const endScale = Math.min(
        END_SCALE,
        (width - 64) / previewWidth,
        (height - 48) / previewHeight,
      );
      const endTop = Math.max(24, (height - previewHeight * endScale) / 2);
      front.style.transform = `translate(-50%, ${startTop + (endTop - startTop) * progress}px) scale(${START_SCALE + (endScale - START_SCALE) * progress})`;
      back.style.transform = `scale(${1 - 0.05 * progress})`;
      back.style.opacity = String(1 - progress);
      if (hint) hint.style.opacity = String(Math.max(0, 1 - progress * 4));
    };
    const schedule = () => {
      if (!request) request = requestAnimationFrame(update);
    };

    // Plays the scroll to the start or the end of the stage, eased, whatever the gesture's size.
    const play = (down: boolean) => {
      const from = window.scrollY;
      const to = down ? root.offsetTop + travel() : root.offsetTop;
      if (Math.abs(to - from) < 2) return;
      cancelAnimationFrame(playing);
      const began = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - began) / PLAY_MS);
        window.scrollTo(0, from + (to - from) * easeInOut(t));
        if (t < 1) playing = requestAnimationFrame(step);
        else {
          playing = 0;
          quietUntil = performance.now() + SETTLE_MS;
        }
      };
      playing = requestAnimationFrame(step);
    };
    // Within the stage, a gesture only says which way to go.
    const steer = (event: Event, down: boolean) => {
      if (!query.matches) return;
      const end = root.offsetTop + travel();
      // Past the stage there is more page only when something follows it; let that scroll.
      if (down && window.scrollY >= end - 1) return;
      if (!down && window.scrollY > end + 1) return;
      event.preventDefault();
      if (playing || performance.now() < quietUntil) return;
      play(down);
    };
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 1 || event.ctrlKey) return;
      steer(event, event.deltaY > 0);
    };
    let touchY: number | null = null;
    const touchStart = (event: TouchEvent) => (touchY = event.touches[0]?.clientY ?? null);
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchY === null || y === undefined || Math.abs(y - touchY) < 8) return;
      steer(event, y < touchY);
    };
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (DOWN_KEYS.has(event.key) && !(event.key === ' ' && event.shiftKey)) steer(event, true);
      else if (UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)) steer(event, false);
    };

    // The cue plays the rise too, rather than jumping to the preview.
    const cueClick = (event: MouseEvent) => {
      if (!query.matches) return;
      event.preventDefault();
      play(true);
    };
    hint?.addEventListener('click', cueClick);

    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('touchstart', touchStart, { passive: true });
    window.addEventListener('touchmove', touchMove, { passive: false });
    window.addEventListener('keydown', key);
    query.addEventListener('change', schedule);
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resized?.observe(back);
    resized?.observe(front);
    return () => {
      cancelAnimationFrame(request);
      cancelAnimationFrame(playing);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('wheel', wheel);
      window.removeEventListener('touchstart', touchStart);
      window.removeEventListener('touchmove', touchMove);
      window.removeEventListener('keydown', key);
      query.removeEventListener('change', schedule);
      hint?.removeEventListener('click', cueClick);
      resized?.disconnect();
      clear();
    };
  }, []);

  return (
    <div className="scroll-stage" ref={stage} style={{ ['--stage-travel' as string]: TRAVEL }}>
      <div className="scroll-stage-view">
        <div className="scroll-stage-hero" ref={heroLayer}>
          {hero}
        </div>
        {cue && (
          <div className="scroll-stage-cue" ref={cueLayer}>
            {cue}
          </div>
        )}
        <div className="scroll-stage-preview" ref={previewLayer}>
          {preview}
        </div>
      </div>
    </div>
  );
}
