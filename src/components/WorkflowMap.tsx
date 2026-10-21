import { GitPullRequest } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import { Mark } from './Brand';

const PULSE_EVERY_MS = 10000;
const FIRST_PULSE_MS = 1200;
const TRAVEL_MS = 1100;
const SPIN_MS = 750;
const TAIL_DOTS = 14;
// Distance between tail dots, in the SVG's 960 × 160 units.
const TAIL_SPACING = 4;
const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// The map above the walkthrough. Every ten seconds a blue signal with a tail
// runs from the API change into Refit, the Refit node spins, and the signal
// carries on to the draft pull request.
export function WorkflowMap({ active }: { active: boolean }) {
  const incoming = useRef<SVGPathElement>(null);
  const outgoing = useRef<SVGPathElement>(null);
  const engine = useRef<HTMLDivElement>(null);
  const output = useRef<HTMLDivElement>(null);
  const signal = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const path = incoming.current!;
    if (!active || typeof path.getTotalLength !== 'function' || !engine.current!.animate) return;
    const dots = [...signal.current!.children] as HTMLElement[];
    const animations: Animation[] = [];
    let stopped = false;
    let timeout = 0;

    // Moves the head along the path and lets the tail follow it in, so the
    // last dot disappears into the node rather than stopping short. `arrive`
    // fires the moment the head reaches the end.
    const travel = (route: SVGPathElement, arrive: () => void) => {
      const svg = route.ownerSVGElement!;
      const length = route.getTotalLength();
      const distance = length + TAIL_DOTS * TAIL_SPACING;
      const began = performance.now();
      let arrived = false;
      const tick = (now: number) => {
        if (stopped) return;
        const t = Math.min(1, (now - began) / TRAVEL_MS);
        const head = easeInOut(t) * distance;
        const scaleX = svg.clientWidth / 960;
        const scaleY = svg.clientHeight / 160;
        dots.forEach((dot, index) => {
          const along = head - index * TAIL_SPACING;
          if (along < 0 || along > length) {
            dot.style.opacity = '0';
            return;
          }
          const point = route.getPointAtLength(along);
          dot.style.opacity = String(1 - index / TAIL_DOTS);
          // The tail narrows behind the head like a comet.
          dot.style.transform = `translate(${point.x * scaleX}px, ${point.y * scaleY}px) scale(${1 - (index / TAIL_DOTS) * 0.65})`;
        });
        if (!arrived && head >= length) {
          arrived = true;
          arrive();
        }
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const pulse = () => {
      travel(incoming.current!, () => {
        const spin = engine.current!.animate(
          [
            { transform: 'rotate(0) scale(1)' },
            { transform: 'rotate(180deg) scale(1.08)' },
            { transform: 'rotate(360deg) scale(1)' },
          ],
          { duration: SPIN_MS, easing: EASE },
        );
        animations.push(spin);
        spin.onfinish = () =>
          travel(outgoing.current!, () => {
            animations.push(
              output.current!.animate(
                [{ borderColor: '#0048d8', boxShadow: '0 0 0 4px #0048d81f' }, {}],
                { duration: 900, easing: 'ease-out' },
              ),
            );
          });
      });
      timeout = window.setTimeout(pulse, PULSE_EVERY_MS);
    };
    timeout = window.setTimeout(pulse, FIRST_PULSE_MS);

    return () => {
      stopped = true;
      window.clearTimeout(timeout);
      for (const animation of animations) animation.cancel();
      for (const dot of dots) dot.style.opacity = '0';
    };
  }, [active]);

  return (
    <div className="workflow-map" aria-hidden="true">
      <svg className="workflow-lines" viewBox="0 0 960 160" preserveAspectRatio="none">
        <path ref={incoming} d="M205 80H365Q385 80 385 60V55Q385 35 405 35H450" />
        <path ref={outgoing} d="M510 35H555Q575 35 575 55V60Q575 80 595 80H755" />
      </svg>
      <div className="map-signal" ref={signal}>
        {Array.from({ length: TAIL_DOTS }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <div className="map-endpoint map-source">
        <div className="provider-symbol">S</div>
        <div>
          <strong>API change</strong>
          <span>stripe / openapi</span>
        </div>
        <span className="map-dot" />
      </div>
      <div className="map-center">
        <div className="engine-node" ref={engine}>
          <Mark />
        </div>
        <span>refit</span>
      </div>
      <div className="map-endpoint map-output" ref={output}>
        <GitPullRequest size={24} />
        <div>
          <strong>Draft pull request</strong>
          <span>Ready for your review</span>
        </div>
      </div>
      <div className="map-caption">From upstream change to downstream fix.</div>
    </div>
  );
}
