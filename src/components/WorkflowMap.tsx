import { GitPullRequest } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { onBeat, SPIN_END_MS, SPIN_START_MS, SWAP_MS } from '../beat';
import { Mark } from './Brand';
import { BrandLogo } from './BrandLogo';

const TAIL_DOTS = 14;
// Distance between tail dots, in the SVG's 960 × 160 units.
const TAIL_SPACING = 4;

// Illustrative sources, one per cycle, for the providers on the logo belt.
const providers = [
  { id: 'stripe', source: 'stripe / openapi' },
  { id: 'openai', source: 'openai / openapi' },
  { id: 'anthropic', source: 'anthropic / changelog' },
  { id: 'twilio', source: 'twilio / openapi' },
  { id: 'shopify', source: 'shopify / graphql' },
  { id: 'meta', source: 'meta / graph api' },
  { id: 'gemini', source: 'gemini / changelog' },
  { id: 'google', source: 'google / discovery' },
  { id: 'slack', source: 'slack / changelog' },
  { id: 'paypal', source: 'paypal / openapi' },
  { id: 'salesforce', source: 'salesforce / release notes' },
  { id: 'cloudflare', source: 'cloudflare / openapi' },
];

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// The share of the trip at which an eased head covers `fraction` of the way.
function timeToCover(fraction: number) {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i++) {
    const middle = (low + high) / 2;
    if (easeInOut(middle) < fraction) low = middle;
    else high = middle;
  }
  return high;
}

// Whether the map should animate: on screen, in a visible tab, and motion allowed.
function useActive(root: RefObject<HTMLDivElement | null>) {
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(!document.hidden);
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (root.current) observer.observe(root.current);
    const update = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [root]);
  return visible && foreground && !reduced;
}

// The pipeline map runs on every beat, back to back. A blue signal with a tail
// reaches Refit, the Refit node glows while it works (as the hero's ASCII mark
// spins on every third beat), and the signal carries on to the draft pull
// request. As it lands, the API change card moves to the next provider, whose
// signal leaves on the next beat. Without `active` it decides for itself.
export function WorkflowMap({ active: given }: { active?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const own = useActive(root);
  const active = given ?? own;
  const incoming = useRef<SVGPathElement>(null);
  const outgoing = useRef<SVGPathElement>(null);
  const engine = useRef<HTMLDivElement>(null);
  const output = useRef<HTMLDivElement>(null);
  // Two sets of dots, so one signal's tail can drain into the pull request
  // while the next one is already leaving the API change.
  const signalIn = useRef<HTMLDivElement>(null);
  const signalOut = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const provider = providers[current];

  useEffect(() => {
    const path = incoming.current!;
    if (!active || typeof path.getTotalLength !== 'function' || !engine.current!.animate) return;
    const dotsIn = [...signalIn.current!.children] as HTMLElement[];
    const dotsOut = [...signalOut.current!.children] as HTMLElement[];
    const animations: Animation[] = [];
    const timeouts: number[] = [];
    let stopped = false;
    const later = (delay: number, run: () => void) => timeouts.push(window.setTimeout(run, delay));

    // Moves the head along the path and lets the tail follow it in, so the
    // last dot disappears into the node rather than stopping short. The trip
    // is paced so the head reaches the end `arriveAfter` ms from now, when
    // `arrive` fires.
    const travel = (
      route: SVGPathElement,
      dots: HTMLElement[],
      arriveAfter: number,
      arrive: () => void,
    ) => {
      const svg = route.ownerSVGElement!;
      const length = route.getTotalLength();
      const distance = length + TAIL_DOTS * TAIL_SPACING;
      const duration = arriveAfter / timeToCover(length / distance);
      const began = performance.now();
      let arrived = false;
      const tick = (now: number) => {
        if (stopped) return;
        const t = Math.min(1, (now - began) / duration);
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

    const stop = onBeat(() => {
      travel(incoming.current!, dotsIn, SPIN_START_MS, () => {});
      // The node holds still and glows while the signal is inside it, started in
      // the same frame with a delay so it lines up with the hero's ASCII spin.
      animations.push(
        engine.current!.animate(
          [
            { boxShadow: '0 0 0 0 #0048d800' },
            { boxShadow: '0 0 0 10px #0048d826', offset: 0.5 },
            { boxShadow: '0 0 0 0 #0048d800' },
          ],
          { duration: SPIN_END_MS - SPIN_START_MS, delay: SPIN_START_MS, easing: 'ease-in-out' },
        ),
      );
      later(SPIN_END_MS, () =>
        travel(outgoing.current!, dotsOut, SWAP_MS - SPIN_END_MS, () => {
          animations.push(
            output.current!.animate(
              [{ borderColor: '#0048d8', boxShadow: '0 0 0 4px #0048d81f' }, {}],
              { duration: 900, easing: 'ease-out' },
            ),
          );
          setCurrent((index) => (index + 1) % providers.length);
        }),
      );
    });

    return () => {
      stopped = true;
      stop();
      for (const timeout of timeouts) window.clearTimeout(timeout);
      for (const animation of animations) animation.cancel();
      for (const dot of [...dotsIn, ...dotsOut]) dot.style.opacity = '0';
    };
  }, [active]);

  return (
    <div className="workflow-map" aria-hidden="true" ref={root}>
      <svg className="workflow-lines" viewBox="0 0 960 160" preserveAspectRatio="none">
        <path ref={incoming} d="M205 80H365Q385 80 385 60V55Q385 35 405 35H450" />
        <path ref={outgoing} d="M510 35H555Q575 35 575 55V60Q575 80 595 80H755" />
      </svg>
      {[signalIn, signalOut].map((layer, which) => (
        <div className="map-signal" ref={layer} key={which}>
          {Array.from({ length: TAIL_DOTS }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      ))}
      <div className="map-endpoint map-source">
        <div className="provider-symbol" key={provider.id}>
          <BrandLogo id={provider.id} />
        </div>
        <div>
          <strong>API change</strong>
          <span className="provider-source" key={provider.id}>
            {provider.source}
          </span>
        </div>
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
