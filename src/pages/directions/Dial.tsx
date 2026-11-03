import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { WaitlistForm } from '../../components/WaitlistForm';
import { FilmPlayer, LoopPlayer, pop, tween } from './film/Film';
import type { FilmTheme } from './film/Film';
import { Wordmark } from './shared';
import './dial.css';

const THEME: FilmTheme = {
  bg: '#0f1012',
  panel: '#17191d',
  line: '#2c2f35',
  ink: '#eceef1',
  muted: '#9298a3',
  accent: '#7c8cff',
  accentInk: '#0a0f33',
  tint: 'rgba(124, 140, 255, 0.16)',
  added: '#6ee7a8',
  addedBg: 'rgba(110, 231, 168, 0.12)',
  removed: '#ff8f8f',
  removedBg: 'rgba(255, 143, 143, 0.13)',
  keyword: '#a9b4ff',
  string: '#f6c177',
  pass: '#3fb873',
  warn: '#e3a33b',
  shadow: '0 30px 60px -30px rgba(0, 0, 0, 0.8)',
  radius: 16,
  sans: "'Geist Variable', sans-serif",
  mono: "'Geist Mono Variable', monospace",
};

const SIZE = 900;
const CENTRE = SIZE / 2;
const RING = 330;
// Two turns of the sweep, six seconds each.
const TURN = 180;
const LOOP = TURN * 2;
const ALERT = '#f5b544';

const ARCS = [
  { name: 'Slack', color: '#36c5f0', from: 4, to: 86 },
  { name: 'Shopify', color: '#95bf47', from: 94, to: 176 },
  { name: 'Twilio', color: '#f2546a', from: 184, to: 266 },
  { name: 'OpenAI', color: '#e6e6e6', from: 274, to: 356 },
];

// Illustrative changes, each caught as the sweep passes its provider: three end in a draft pull
// request, one in a "not affected" verdict.
const EVENTS = [
  {
    provider: 'Slack',
    angle: 40,
    turn: 0,
    change: 'files.upload retired',
    verdict: 'Draft PR #12',
  },
  { provider: 'Twilio', angle: 230, turn: 0, change: 'Node SDK 5.0', verdict: 'Draft PR #13' },
  {
    provider: 'Shopify',
    angle: 130,
    turn: 1,
    change: 'Admin API 2024-01',
    verdict: 'Not affected',
  },
  { provider: 'OpenAI', angle: 310, turn: 1, change: 'Model retirement', verdict: 'Draft PR #14' },
].map((event) => ({
  ...event,
  frame: event.turn * TURN + (event.angle / 360) * TURN,
  color: ARCS.find((arc) => arc.name === event.provider)!.color,
}));

function point(angle: number, radius: number) {
  const radians = (angle * Math.PI) / 180;
  return [CENTRE + radius * Math.sin(radians), CENTRE - radius * Math.cos(radians)] as const;
}

function arc(from: number, to: number, radius: number) {
  const [x1, y1] = point(from, radius);
  const [x2, y2] = point(to, radius);
  return `M${x1} ${y1} A${radius} ${radius} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

function wedge(from: number, to: number, radius: number) {
  const [x1, y1] = point(from, radius);
  const [x2, y2] = point(to, radius);
  return `M${CENTRE} ${CENTRE} L${x1} ${y1} A${radius} ${radius} 0 0 1 ${x2} ${y2} Z`;
}

type DialProps = { accent: string };

// The watch dial: one sweep per six seconds across every provider the code calls.
function WatchDial({ accent }: DialProps) {
  const frame = useCurrentFrame();
  const sweep = ((frame / TURN) * 360) % 360;
  const caught = EVENTS.filter((event) => frame >= event.frame);
  const current = caught.at(-1);
  const age = current ? frame - current.frame : frame;
  return (
    <AbsoluteFill style={{ background: THEME.bg, fontFamily: THEME.sans }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
        {Array.from({ length: 72 }, (_, index) => {
          const major = index % 6 === 0;
          const [x1, y1] = point(index * 5, 298);
          const [x2, y2] = point(index * 5, major ? 280 : 289);
          return (
            <line
              key={index}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#3a3d44"
              strokeWidth={major ? 2 : 1}
            />
          );
        })}
        {ARCS.map((entry) => {
          const [x, y] = point((entry.from + entry.to) / 2, 394);
          return (
            <g key={entry.name}>
              <path
                d={arc(entry.from, entry.to, RING)}
                fill="none"
                stroke={entry.color}
                strokeWidth="14"
                strokeLinecap="round"
              />
              <text
                x={x}
                y={y + 8}
                fill={THEME.muted}
                fontSize="24"
                fontWeight="500"
                textAnchor="middle"
              >
                {entry.name}
              </text>
            </g>
          );
        })}
        {Array.from({ length: 14 }, (_, slice) => (
          <path
            key={slice}
            d={wedge(sweep - 4 * (slice + 1), sweep - 4 * slice, 312)}
            fill={accent}
            opacity={0.22 * (1 - slice / 14)}
          />
        ))}
        <line
          x1={point(sweep, 184)[0]}
          y1={point(sweep, 184)[1]}
          x2={point(sweep, 312)[0]}
          y2={point(sweep, 312)[1]}
          stroke={THEME.ink}
          strokeWidth="2"
        />
        {caught.map((event) => {
          const since = frame - event.frame;
          const [x, y] = point(event.angle, RING);
          const [toX, toY] = point(event.angle, 186);
          const reach = tween(since, [4, 16], [0, 1]);
          const live = event === current;
          return (
            <g key={event.provider} opacity={live ? 1 : 0.4}>
              <circle
                cx={x}
                cy={y}
                r={10 + 34 * tween(since, [0, 26], [0, 1])}
                fill="none"
                stroke={ALERT}
                strokeWidth="2"
                opacity={tween(since, [0, 26], [1, 0])}
              />
              <line
                x1={x}
                y1={y}
                x2={x + (toX - x) * reach}
                y2={y + (toY - y) * reach}
                stroke={event.color}
                strokeWidth="2"
                strokeDasharray="5 7"
              />
              <circle
                cx={x}
                cy={y}
                r={10 * Math.min(pop(since), 1.15)}
                fill={ALERT}
                stroke={THEME.bg}
                strokeWidth="4"
              />
            </g>
          );
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          top: CENTRE - 176,
          left: CENTRE - 176,
          display: 'grid',
          placeItems: 'center',
          width: 352,
          height: 352,
          border: `1px solid ${THEME.line}`,
          borderRadius: '50%',
          background: THEME.panel,
          textAlign: 'center',
        }}
      >
        {current ? (
          <div key={current.provider} style={{ opacity: tween(age, [6, 16], [0, 1]) }}>
            <div style={{ color: current.color, fontSize: 26, fontWeight: 600 }}>
              {current.provider}
            </div>
            <div
              style={{
                margin: '6px 0 20px',
                color: THEME.ink,
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: '-0.03em',
              }}
            >
              {current.change}
            </div>
            <span
              style={{
                display: 'inline-block',
                padding: '8px 18px',
                border: `1.5px solid ${current.verdict === 'Not affected' ? THEME.line : accent}`,
                borderRadius: 999,
                color: current.verdict === 'Not affected' ? THEME.muted : THEME.accentInk,
                background: current.verdict === 'Not affected' ? 'transparent' : accent,
                fontSize: 21,
                fontWeight: 600,
                opacity: tween(age, [18, 28], [0, 1]),
              }}
            >
              {current.verdict}
            </span>
          </div>
        ) : (
          <div>
            <div style={{ color: THEME.muted, fontSize: 22 }}>Watching</div>
            <div
              style={{ color: THEME.ink, fontSize: 42, fontWeight: 600, letterSpacing: '-0.03em' }}
            >
              4 APIs
            </div>
          </div>
        )}
      </div>
      <span
        style={{
          position: 'absolute',
          bottom: 14,
          width: '100%',
          color: THEME.muted,
          fontSize: 18,
          textAlign: 'center',
        }}
      >
        Illustrative example
      </span>
    </AbsoluteFill>
  );
}

// Direction 4: a dial that never stops watching, after the radial piece on animejs.com.
export function Dial() {
  return (
    <div className="dir dial" id="top">
      <header className="dial-header">
        <Wordmark />
        <a href="#join">Join the waitlist</a>
      </header>
      <main id="main-content">
        <section className="dial-hero">
          <div className="dial-copy">
            <h1>
              Always watching
              <span>the APIs you use.</span>
            </h1>
            <p>When one changes, Refit opens the fix as a pull request.</p>
            <WaitlistForm />
          </div>
          <LoopPlayer
            component={WatchDial}
            inputProps={{ accent: THEME.accent }}
            frames={LOOP}
            size={{ width: SIZE, height: SIZE }}
            rest={60}
            label="the watch dial"
            theme={THEME}
            className="dial-player"
          />
        </section>
        <section className="dial-film" aria-labelledby="dial-film">
          <h2 id="dial-film">One change, start to finish.</h2>
          <FilmPlayer theme={THEME} />
        </section>
        <section className="dial-join" id="join" aria-labelledby="dial-join">
          <h2 id="dial-join">Be ready for the next change.</h2>
          <WaitlistForm />
        </section>
      </main>
      <footer className="dial-footer">
        <p>Examples are illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
