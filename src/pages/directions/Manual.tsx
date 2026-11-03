import '@fontsource/geist-pixel';
import '@fontsource-variable/source-serif-4/opsz.css';
import { Warning } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import { WaitlistForm } from '../../components/WaitlistForm';
import { FilmPlayer } from './film/Film';
import type { FilmTheme } from './film/Film';
import { LIMITS, Wordmark } from './shared';
import './manual.css';

const THEME: FilmTheme = {
  bg: '#f4f6fb',
  panel: '#fbfcff',
  line: '#b8c3e8',
  ink: '#111a3b',
  muted: '#4a5378',
  accent: '#1d43db',
  accentInk: '#ffffff',
  tint: 'rgba(29, 67, 219, 0.1)',
  added: '#1d43db',
  addedBg: 'rgba(29, 67, 219, 0.1)',
  removed: '#9a3b52',
  removedBg: 'rgba(154, 59, 82, 0.1)',
  keyword: '#1d43db',
  string: '#7a4a0a',
  pass: '#1d43db',
  warn: '#b7791f',
  shadow: 'none',
  radius: 0,
  sans: "'Geist Pixel', 'Geist Mono Variable', monospace",
  mono: "'Geist Mono Variable', monospace",
};

// Figure 1 is an isometric drawing: a sheet's x axis runs down and to the right, its y axis down
// and to the left, and each sheet sits GAP units below the one above it.
const COS = Math.cos(Math.PI / 6);
const ORIGIN = { x: 150, y: 24 };
const WIDTH = 220;
const DEPTH = 150;
const GAP = 124;
const THICKNESS = 6;
const LABEL_X = 380;

type Point = [number, number];
type Part = {
  points: Point[];
  closed?: boolean;
  wash?: boolean;
  solid?: boolean;
  dashed?: boolean;
};

function project([x, y]: Point, drop: number) {
  return `${(ORIGIN.x + (x - y) * COS).toFixed(1)},${(ORIGIN.y + (x + y) / 2 + drop).toFixed(1)}`;
}

function rect(x: number, y: number, width: number, height: number, style: Partial<Part> = {}) {
  const points: Point[] = [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
  return { points, closed: true, ...style };
}

function line(x1: number, y1: number, x2: number, y2: number): Part {
  return {
    points: [
      [x1, y1],
      [x2, y2],
    ],
  };
}

const callSiteRows = [22, 48, 74, 100, 126];
const patchRows = [18, 33, 48, 63, 78, 93, 108, 123, 138];
const patchLengths = [120, 150, 90, 170, 140, 176, 180, 110, 60];
const checkRows = [44, 78, 112];

const sheets: { title: string; text: [string, string]; parts: Part[] }[] = [
  {
    title: 'The change',
    text: ['Slack retires the', 'files.upload method.'],
    parts: [
      rect(14, 12, 192, 18),
      line(14, 46, 176, 46),
      line(14, 60, 196, 60),
      line(14, 74, 132, 74),
      rect(10, 88, 200, 46, { wash: true }),
      line(22, 103, 186, 103),
      line(22, 118, 150, 118),
    ],
  },
  {
    title: 'Your call sites',
    text: ['One call in send.ts uses', 'the retired method.'],
    parts: callSiteRows.flatMap((y, row) => {
      const affected = row === 1 || row === 2;
      return [
        ...(affected ? [rect(8, y - 11, 204, 22, { wash: true })] : []),
        rect(14, y - 5, 10, 10, { solid: affected }),
        line(32, y, 32 + [150, 118, 172, 104, 140][row], y),
      ];
    }),
  },
  {
    title: 'The patch',
    text: ['files.upload becomes', 'files.uploadV2.'],
    parts: patchRows.flatMap((y, row) => {
      const removed = row === 3 || row === 4;
      const added = row === 5 || row === 6;
      return [
        ...(added ? [rect(8, y - 6, 204, 12, { wash: true })] : []),
        ...(removed || added ? [line(12, y, 20, y)] : []),
        ...(added ? [line(16, y - 4, 16, y + 4)] : []),
        line(28, y, 28 + patchLengths[row], y),
      ];
    }),
  },
  {
    title: 'The proof',
    text: ['Type check, build and tests,', 'before and after.'],
    parts: [
      line(118, 18, 140, 18),
      line(160, 18, 182, 18),
      ...checkRows.flatMap((y) => [
        line(14, y, 90, y),
        ...[118, 160].flatMap((x) => [
          rect(x, y - 10, 22, 20),
          {
            points: [
              [x + 5, y],
              [x + 9, y + 5],
              [x + 17, y - 5],
            ] as Point[],
          },
        ]),
      ]),
    ],
  },
  {
    title: 'The pull request',
    text: ['A draft, explained to you', 'by your coding agent.'],
    parts: [
      rect(14, 14, 192, 24, { wash: true }),
      rect(14, 48, 44, 14),
      line(70, 55, 180, 55),
      line(14, 80, 196, 80),
      line(14, 94, 168, 94),
      line(14, 108, 184, 108),
      rect(118, 122, 88, 20, { dashed: true }),
    ],
  },
];

const corners: Point[] = [
  [0, 0],
  [WIDTH, 0],
  [WIDTH, DEPTH],
  [0, DEPTH],
];

function Sheet({ index }: { index: number }) {
  const sheet = sheets[index];
  const drop = index * GAP;
  const [top, right, bottom, left] = corners.map((corner) => project(corner, drop));
  const below = (point: Point) => project(point, drop + THICKNESS);
  const rightY = ORIGIN.y + WIDTH / 2 + drop;
  return (
    <g className="manual-sheet" style={{ '--lift': `${(-index * GAP) / 2}px` } as CSSProperties}>
      <polygon
        className="manual-edge"
        points={`${left} ${bottom} ${right} ${below(corners[1])} ${below(corners[2])} ${below(corners[3])}`}
      />
      <polygon className="manual-paper" points={`${top} ${right} ${bottom} ${left}`} />
      {sheet.parts.map((part, key) => {
        const points = part.points.map((point) => project(point, drop)).join(' ');
        const className = part.wash
          ? 'manual-wash'
          : part.solid
            ? 'manual-solid'
            : part.dashed
              ? 'manual-dashed'
              : 'manual-stroke';
        return part.closed ? (
          <polygon key={key} className={className} points={points} />
        ) : (
          <polyline key={key} className={className} points={points} />
        );
      })}
      <polyline className="manual-leader" points={`${right} ${LABEL_X - 10},${rightY}`} />
      <circle className="manual-solid" cx={right.split(',')[0]} cy={rightY} r="2.5" />
      <text className="manual-label-title" x={LABEL_X} y={rightY - 14}>
        {index + 1} {sheet.title}
      </text>
      <text className="manual-label-text" x={LABEL_X} y={rightY + 6}>
        <tspan x={LABEL_X}>{sheet.text[0]}</tspan>
        <tspan x={LABEL_X} dy="17">
          {sheet.text[1]}
        </tspan>
      </text>
    </g>
  );
}

function ExplodedView() {
  const guide = (corner: Point) => {
    const [x, y] = project(corner, 0).split(',');
    const end = project(corner, (sheets.length - 1) * GAP).split(',')[1];
    return <line key={corner.join()} className="manual-guide" x1={x} y1={y} x2={x} y2={end} />;
  };
  return (
    <svg
      className="manual-exploded"
      viewBox="0 0 640 724"
      role="img"
      aria-labelledby="manual-figure-title"
    >
      <title id="manual-figure-title">
        An exploded drawing of one migration: the provider’s change, your call sites, the patch, the
        checks and the pull request, stacked from top to bottom.
      </title>
      {corners.slice(1).map(guide)}
      {sheets
        .map((_, index) => sheets.length - 1 - index)
        .map((index) => (
          <Sheet key={index} index={index} />
        ))}
    </svg>
  );
}

// Direction 7: Refit written up as a technical manual, with blue-ink figures on cool paper: the
// migration exploded in one figure and played as a film in the next.
export function Manual() {
  return (
    <div className="dir manual" id="top">
      <header className="manual-header">
        <Wordmark />
        <p>Field manual. In development.</p>
        <a href="#join">Join the waitlist</a>
      </header>
      <main id="main-content">
        <section className="manual-opening">
          <h1>API change in. Pull request out.</h1>
          <div className="manual-rule" />
          <div className="manual-spread">
            <figure className="manual-figure">
              <ExplodedView />
              <figcaption>
                <span>Fig. 1</span> One migration, exploded.
              </figcaption>
            </figure>
            <div className="manual-side">
              <figure className="manual-inset">
                <FilmPlayer theme={THEME} />
                <figcaption>
                  <span>Fig. 2</span> The same migration, in motion. Illustrative.
                </figcaption>
              </figure>
              <WaitlistForm />
            </div>
          </div>
        </section>

        <section className="manual-chapter manual-pair">
          <div className="manual-caution" role="note" aria-labelledby="manual-limits">
            <h2 id="manual-limits">
              <Warning weight="bold" aria-hidden="true" /> What it will never do
            </h2>
            <ul>
              {LIMITS.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </div>
          <div aria-labelledby="manual-specs">
            <h2 id="manual-specs">Specifications</h2>
            <dl className="manual-specs">
              <dt>Installs as</dt>
              <dd>A GitHub App, on all or selected repositories</dd>
              <dt>Finds</dt>
              <dd>SDKs, raw HTTP, GraphQL and webhooks</dd>
              <dt>Proof</dt>
              <dd>Your own checks, before and after</dd>
              <dt>Result</dt>
              <dd>A pull request, or a “not affected” verdict</dd>
            </dl>
          </div>
        </section>

        <section className="manual-chapter manual-join" id="join" aria-labelledby="manual-join">
          <h2 id="manual-join">Request early access</h2>
          <WaitlistForm />
        </section>
      </main>
      <footer className="manual-colophon">
        <p>Examples are illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
