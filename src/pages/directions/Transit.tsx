import '@fontsource-variable/overpass/wght.css';
import {
  ArrowCounterClockwise,
  CheckCircle,
  CurrencyDollar,
  GitPullRequest,
  Key,
  ShieldCheck,
  Warning,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { WaitlistForm } from '../../components/WaitlistForm';
import { FilmPlayer } from './film/Film';
import type { FilmTheme } from './film/Film';
import { EXAMPLE, LIMITS, Wordmark } from './shared';
import './transit.css';

const THEME: FilmTheme = {
  bg: '#f3f4f6',
  panel: '#ffffff',
  line: '#dfe2e8',
  ink: '#000000',
  muted: '#4d535e',
  accent: '#0048d8',
  accentInk: '#ffffff',
  tint: 'rgba(0, 72, 216, 0.08)',
  added: '#2f6f22',
  addedBg: 'rgba(79, 127, 50, 0.12)',
  removed: '#c0182f',
  removedBg: 'rgba(216, 30, 60, 0.1)',
  keyword: '#635bff',
  string: '#4f7f32',
  pass: '#1f8a3b',
  warn: '#a35f00',
  shadow: '0 24px 48px -28px rgba(0, 0, 0, 0.3)',
  radius: 10,
  sans: "'Overpass Variable', sans-serif",
  mono: "'Geist Mono Variable', monospace",
};

type Phase = 'quiet' | 'alert' | 'rerouted';

// One illustrative repository as a transit map: each provider is a line, each file that calls it
// a stop, and a file that calls several providers an interchange.
const LINES = [
  {
    id: 'stripe',
    name: 'Stripe',
    how: 'Node SDK 10.17.0, API 2022-08-01',
    color: '#635bff',
    path: 'M100 280 H360 L460 180 H760 L860 280 H1080',
    tag: { x: 8, y: 268, width: 72 },
  },
  {
    id: 'twilio',
    name: 'Twilio',
    how: 'Node SDK 4.19.0',
    color: '#d81e3c',
    path: 'M300 84 V400 L380 480 H620',
    tag: { x: 264, y: 36, width: 72 },
  },
  {
    id: 'shopify',
    name: 'Shopify',
    how: 'GraphQL Admin API',
    color: '#4f7f32',
    path: 'M960 84 V380 L1040 460 H1090',
    tag: { x: 918, y: 36, width: 84 },
  },
  {
    id: 'slack',
    name: 'Slack',
    how: '@slack/web-api 6.9.0',
    color: '#4a154b',
    path: 'M520 380 H860',
    tag: { x: 420, y: 368, width: 72 },
  },
];

type Label = 'above' | 'below' | 'left' | 'right' | 'below-left' | 'below-right';

const STOPS: { name: string; x: number; y: number; line?: string; label: Label }[] = [
  { name: 'checkout.ts', x: 100, y: 280, line: 'stripe', label: 'below' },
  { name: 'payments.ts', x: 300, y: 280, label: 'below-right' },
  { name: 'refunds.ts', x: 540, y: 180, line: 'stripe', label: 'above' },
  { name: 'invoices.ts', x: 700, y: 180, line: 'stripe', label: 'above' },
  { name: 'webhooks.ts', x: 960, y: 280, label: 'below-left' },
  { name: 'portal.ts', x: 1080, y: 280, line: 'stripe', label: 'below' },
  { name: 'signup.ts', x: 300, y: 84, line: 'twilio', label: 'right' },
  { name: 'notify.ts', x: 300, y: 380, line: 'twilio', label: 'left' },
  { name: 'verify.ts', x: 460, y: 480, line: 'twilio', label: 'below' },
  { name: 'sms.ts', x: 620, y: 480, line: 'twilio', label: 'below' },
  { name: 'orders.ts', x: 960, y: 84, line: 'shopify', label: 'right' },
  { name: 'inventory.ts', x: 960, y: 180, line: 'shopify', label: 'right' },
  { name: 'fulfillment.ts', x: 1090, y: 460, line: 'shopify', label: 'below' },
  { name: 'alerts.ts', x: 520, y: 380, line: 'slack', label: 'below' },
  { name: 'reports/send.ts', x: 690, y: 380, line: 'slack', label: 'below' },
  { name: 'digest.ts', x: 860, y: 380, line: 'slack', label: 'below' },
];
const CHANGED_LINE = 'slack';
const AFFECTED = 'reports/send.ts';

const LABEL_AT: Record<Label, { dx: number; dy: number; anchor: 'start' | 'middle' | 'end' }> = {
  above: { dx: 0, dy: -20, anchor: 'middle' },
  below: { dx: 0, dy: 30, anchor: 'middle' },
  left: { dx: -18, dy: 5, anchor: 'end' },
  right: { dx: 18, dy: 5, anchor: 'start' },
  'below-left': { dx: -16, dy: 32, anchor: 'end' },
  'below-right': { dx: 16, dy: 32, anchor: 'start' },
};

const RULE_ICONS = [ShieldCheck, CurrencyDollar, GitPullRequest, Key];

function status(line: (typeof LINES)[number], phase: Phase) {
  if (line.id !== CHANGED_LINE || phase === 'quiet')
    return {
      tone: 'good',
      icon: <CheckCircle weight="fill" />,
      state: 'Good service',
      detail: line.how,
    };
  if (phase === 'alert')
    return {
      tone: 'change',
      icon: <Warning weight="fill" />,
      state: 'Service change',
      detail: `${EXAMPLE.oldMethod} is retired. 1 of 3 stops affected: ${AFFECTED}.`,
    };
  return {
    tone: 'rerouted',
    icon: <GitPullRequest weight="bold" />,
    state: 'Rerouted',
    detail: `Draft pull request #${EXAMPLE.number} updates ${AFFECTED}. Checks pass before and after.`,
  };
}

function TransitMap({ phase }: { phase: Phase }) {
  return (
    <svg
      className={`transit-map is-${phase}`}
      viewBox="0 0 1160 520"
      role="img"
      aria-labelledby="transit-map-title"
    >
      <title id="transit-map-title">
        A transit map of an illustrative repository. Stripe, Twilio, Shopify and Slack are lines;
        the files that call them are stops. payments.ts is an interchange of Stripe and Twilio.
      </title>
      {LINES.map((line) => (
        <path
          key={line.id}
          className={`transit-line ${line.id === CHANGED_LINE ? 'is-changed' : ''}`}
          d={line.path}
          stroke={line.color}
        />
      ))}
      <path
        className="transit-pulse"
        d={LINES.find((line) => line.id === CHANGED_LINE)!.path}
        pathLength={1000}
      />
      {LINES.map((line) => (
        <g key={line.id} className="transit-tag">
          <rect
            x={line.tag.x}
            y={line.tag.y}
            width={line.tag.width}
            height="24"
            fill={line.color}
          />
          <text x={line.tag.x + line.tag.width / 2} y={line.tag.y + 17}>
            {line.name}
          </text>
        </g>
      ))}
      {STOPS.map((stop) => {
        const label = LABEL_AT[stop.label];
        const color = LINES.find((line) => line.id === stop.line)?.color;
        return (
          <g
            key={stop.name}
            className={`transit-stop ${stop.name === AFFECTED ? 'is-affected' : ''}`}
          >
            {stop.name === AFFECTED && (
              <circle className="transit-halo" cx={stop.x} cy={stop.y} r="24" />
            )}
            <circle
              cx={stop.x}
              cy={stop.y}
              r={color ? 7 : 11}
              stroke={color ?? '#000'}
              className="transit-dot"
            />
            <text x={stop.x + label.dx} y={stop.y + label.dy} textAnchor={label.anchor}>
              {stop.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Direction 10: the API usage map drawn as a transit map. When it comes into view, a service
// change runs down the Slack line, the one affected stop lights up, and a pull request reroutes
// it.
export function Transit() {
  const stage = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('quiet');
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhase('rerouted');
      return;
    }
    let timers: number[] = [];
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        setPhase('quiet');
        timers = [
          window.setTimeout(() => setPhase('alert'), 900),
          window.setTimeout(() => setPhase('rerouted'), 4400),
        ];
      },
      { threshold: 0.6 },
    );
    observer.observe(stage.current!);
    return () => {
      observer.disconnect();
      timers.forEach(window.clearTimeout);
    };
  }, [run]);

  return (
    <div className="dir transit" id="top">
      <header className="transit-header">
        <Wordmark />
        <a href="#join">Join the waitlist</a>
      </header>
      <main id="main-content">
        <section className="transit-hero">
          <div className="transit-copy">
            <h1>Every API your code calls, on one map.</h1>
            <p>When an API changes, Refit finds the affected stops and reroutes them.</p>
            <WaitlistForm />
          </div>
          <div className="transit-status" aria-live="polite">
            <p className="transit-status-title">
              Line status <span>{EXAMPLE.repository}, illustrative</span>
            </p>
            <ul>
              {LINES.map((line) => {
                const { tone, icon, state, detail } = status(line, phase);
                return (
                  <li key={line.id} className={`is-${tone}`}>
                    <span className="transit-chip" style={{ background: line.color }}>
                      {line.name}
                    </span>
                    <div>
                      <strong>
                        {icon} {state}
                      </strong>
                      <span>{detail}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
            <button type="button" onClick={() => setRun((count) => count + 1)}>
              <ArrowCounterClockwise /> Replay the change
            </button>
          </div>
        </section>

        <div
          className="transit-stage"
          ref={stage}
          tabIndex={0}
          role="region"
          aria-label="Map of an illustrative repository"
        >
          <TransitMap phase={phase} />
        </div>

        <section className="transit-section" aria-labelledby="transit-legend">
          <h2 id="transit-legend">How to read the map</h2>
          <dl className="transit-legend">
            <div>
              <dt>
                <svg viewBox="0 0 64 24" aria-hidden="true">
                  <path d="M4 12 H60" stroke="#635bff" strokeWidth="8" strokeLinecap="round" />
                </svg>
                A line
              </dt>
              <dd>An API your code calls.</dd>
            </div>
            <div>
              <dt>
                <svg viewBox="0 0 64 24" aria-hidden="true">
                  <path d="M4 12 H60" stroke="#635bff" strokeWidth="8" strokeLinecap="round" />
                  <circle cx="32" cy="12" r="7" fill="#fff" stroke="#635bff" strokeWidth="4" />
                </svg>
                A stop
              </dt>
              <dd>A file that calls it.</dd>
            </div>
            <div>
              <dt>
                <svg viewBox="0 0 64 24" aria-hidden="true">
                  <circle cx="32" cy="12" r="9" fill="#fff" stroke="#000" strokeWidth="4" />
                </svg>
                An interchange
              </dt>
              <dd>A file that calls several.</dd>
            </div>
            <div>
              <dt>
                <svg viewBox="0 0 64 24" aria-hidden="true">
                  <circle cx="32" cy="12" r="11" fill="#ffb81c" />
                  <circle cx="32" cy="12" r="6" fill="#fff" stroke="#000" strokeWidth="3" />
                </svg>
                A service change
              </dt>
              <dd>An upstream change that hits a stop.</dd>
            </div>
          </dl>
        </section>

        <section className="transit-section" aria-labelledby="transit-film">
          <h2 id="transit-film">Watch one reroute.</h2>
          <FilmPlayer theme={THEME} />
        </section>

        <section className="transit-section" aria-labelledby="transit-rules">
          <h2 id="transit-rules">Rules of the network</h2>
          <ul className="transit-rules">
            {LIMITS.map((limit, index) => {
              const Icon = RULE_ICONS[index];
              return (
                <li key={limit}>
                  <Icon weight="bold" />
                  {limit}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="transit-join" id="join" aria-labelledby="transit-join">
          <h2 id="transit-join">Put your codebase on the map.</h2>
          <WaitlistForm />
        </section>
      </main>
      <footer className="transit-footer">
        <p>The map and film are illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
