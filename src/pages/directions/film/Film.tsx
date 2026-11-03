import { Pause, Play } from '@phosphor-icons/react';
import { Player } from '@remotion/player';
import type { CallbackListener, PlayerRef } from '@remotion/player';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ComponentType, CSSProperties, PointerEvent, ReactNode, RefObject } from 'react';
import { AbsoluteFill, Easing, Sequence, interpolate, spring, useCurrentFrame } from 'remotion';
import { apiLogos } from '../../../apiLogos';
import { MARK_BOX, MARK_PATH } from '../../../components/Brand';
import { useReducedMotion } from '../../../components/Workflow';
import { EXAMPLE } from '../shared';
import './film.css';

// The demo film: one illustrative migration told in five shots, drawn with Remotion so every
// value comes from the frame number. Each direction passes its own theme.
export type FilmTheme = {
  bg: string;
  panel: string;
  line: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
  tint: string;
  added: string;
  addedBg: string;
  removed: string;
  removedBg: string;
  keyword: string;
  string: string;
  pass: string;
  warn: string;
  shadow: string;
  radius: number;
  sans: string;
  mono: string;
  // The Refit mark's colour; the accent unless a page sets it.
  logo?: string;
};

export const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;
// Frames each shot overlaps the next, so they cross-fade.
const FADE = 8;

const SCENE_FRAMES = { change: 90, find: 108, fix: 120, prove: 102, ship: 96, brief: 168, end: 66 };
export type SceneId = keyof typeof SCENE_FRAMES;

// A shot's last frame before it fades out, where its clip rests.
const clipRest = (scene: SceneId) => SCENE_FRAMES[scene] - FADE - 1;
// Where a clip the page brings into focus starts: past the fade-in and every shot's entrance, so
// its window never goes black, with all of the shot's action still to come.
const CLIP_START = 16;

// How long a clip takes to play through to where it rests, in milliseconds.
export function clipDuration(scene: SceneId) {
  return (clipRest(scene) / FPS) * 1000;
}

const ORDER = Object.keys(SCENE_FRAMES) as SceneId[];
const STARTS = Object.fromEntries(
  ORDER.map((id, index) => [
    id,
    ORDER.slice(0, index).reduce((sum, earlier) => sum + SCENE_FRAMES[earlier] - FADE, 0),
  ]),
) as Record<SceneId, number>;
export const FILM_FRAMES = STARTS.end + SCENE_FRAMES.end;
// Under reduced motion the film rests on the agent's explanation, after the merge.
const POSTER_FRAME = STARTS.brief + 150;

export const CHAPTERS = (['change', 'find', 'fix', 'prove', 'ship', 'brief'] as const).map(
  (scene, index, scenes) => ({
    label: scene[0].toUpperCase() + scene.slice(1),
    from: STARTS[scene],
    to: index === scenes.length - 1 ? FILM_FRAMES : STARTS[scenes[index + 1]],
  }),
);

const CODE = [
  "import { WebClient } from '@slack/web-api';",
  '',
  'const slack = new WebClient(process.env.SLACK_BOT_TOKEN);',
  '',
  'export async function sendReport(channel: string, report: Buffer) {',
  '  await slack.files.upload({',
  '    channels: channel,',
  '    file: report,',
  "    filename: 'weekly-report.csv',",
  '  });',
  '}',
];
const ADDED = ['  await slack.files.uploadV2({', '    channel_id: channel,'];
// The retired call and the parameter it renames.
const CALL_SITES = [5, 6];
const KEYWORDS = new Set([
  'import',
  'from',
  'const',
  'new',
  'export',
  'async',
  'function',
  'await',
  'return',
  'typeof',
  'null',
]);

const easeOut = Easing.out(Easing.cubic);
const easeInOut = Easing.inOut(Easing.cubic);

export function tween(
  frame: number,
  [start, end]: [number, number],
  [from, to]: [number, number],
  easing = easeOut,
) {
  return interpolate(frame, [start, end], [from, to], {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

export function pop(frame: number) {
  return spring({ frame, fps: FPS, config: { damping: 14, mass: 0.6 } });
}

const FilmContext = createContext<{ theme: FilmTheme; tagline: string; captions: boolean } | null>(
  null,
);
function useFilm() {
  return useContext(FilmContext)!;
}

function Shell({ frames, children }: { frames: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, FADE, frames - FADE, frames], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}

function Caption({
  children,
  from = 0,
  until,
}: {
  children: ReactNode;
  from?: number;
  until?: number;
}) {
  const { theme, captions } = useFilm();
  const frame = useCurrentFrame();
  if (!captions) return null;
  const enter = tween(frame, [from, from + 14], [0, 1]);
  const leave = until === undefined ? 1 : tween(frame, [until, until + 8], [1, 0]);
  return (
    <div
      style={{
        position: 'absolute',
        top: 50,
        left: 72,
        color: theme.ink,
        fontSize: 50,
        fontWeight: 600,
        letterSpacing: '-0.035em',
        opacity: enter * leave,
        transform: `translateY(${(1 - enter) * 24}px)`,
      }}
    >
      {children}
    </div>
  );
}

function Panel({
  box,
  children,
  style,
}: {
  box: { x: number; y: number; width: number; height: number };
  children: ReactNode;
  style?: CSSProperties;
}) {
  const { theme } = useFilm();
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        overflow: 'hidden',
        border: `1px solid ${theme.line}`,
        borderRadius: theme.radius,
        background: theme.panel,
        boxShadow: theme.shadow,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Pill({
  children,
  color,
  background,
  style,
}: {
  children: ReactNode;
  color: string;
  background: string;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 14px',
        borderRadius: 999,
        color,
        background,
        fontSize: 18,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function CheckIcon({ size = 24, color }: { size?: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flex: 'none' }}>
      <circle cx="12" cy="12" r="11" fill={color} />
      <path
        d="M7 12.5l3.2 3.2L17 9"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WarnIcon({ size = 24, color }: { size?: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flex: 'none' }}>
      <path d="M12 2.5L22.5 21h-21z" fill={color} strokeLinejoin="round" />
      <rect x="11" y="9" width="2" height="6" rx="1" fill="#fff" />
      <rect x="11" y="16.6" width="2" height="2" rx="1" fill="#fff" />
    </svg>
  );
}

function Spinner({ color, track }: { color: string; track: string }) {
  const frame = useCurrentFrame();
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      style={{ flex: 'none', transform: `rotate(${frame * 14}deg)` }}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke={track} strokeWidth="3" />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Mark({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={(size * MARK_BOX.height) / MARK_BOX.width}
      viewBox={`${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`}
    >
      <path d={MARK_PATH} fill={color} />
    </svg>
  );
}

function Code({ text }: { text: string }) {
  const { theme } = useFilm();
  return (
    <>
      {text.split(/('[^']*'?|\b[a-z]+\b)/).map((part, index) =>
        part.startsWith("'") ? (
          <span key={index} style={{ color: theme.string }}>
            {part}
          </span>
        ) : KEYWORDS.has(part) ? (
          <span key={index} style={{ color: theme.keyword }}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

// The editor both the find and fix shots use, at the same place, so the cut between them reads as
// one continuous window.
const EDITOR = { x: 170, y: 160, width: 940, height: 470 };
const LINE = 34;
const CODE_TOP = 66;

function Editor({ children, badge }: { children: ReactNode; badge?: ReactNode }) {
  const { theme } = useFilm();
  return (
    <Panel box={EDITOR}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 52,
          padding: '0 22px',
          borderBottom: `1px solid ${theme.line}`,
          color: theme.muted,
          fontFamily: theme.mono,
          fontSize: 17,
        }}
      >
        <svg width="16" height="18" viewBox="0 0 16 18">
          <path
            d="M2 1h8l4 4v12H2z"
            fill="none"
            stroke={theme.muted}
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        {EXAMPLE.file}
        <span style={{ marginLeft: 'auto' }}>{badge}</span>
      </div>
      {children}
    </Panel>
  );
}

function Row({
  index,
  sign,
  signColor,
  children,
  style,
}: {
  index: number;
  sign?: string;
  signColor?: string;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  const { theme } = useFilm();
  return (
    <div
      style={{
        position: 'absolute',
        top: CODE_TOP + index * LINE,
        right: 0,
        left: 0,
        display: 'flex',
        alignItems: 'center',
        height: LINE,
        fontFamily: theme.mono,
        fontSize: 20,
        whiteSpace: 'pre',
        ...style,
      }}
    >
      <span style={{ width: 58, paddingRight: 14, color: theme.muted, textAlign: 'right' }}>
        {index + 1}
      </span>
      <span style={{ width: 26, color: signColor }}>{sign}</span>
      <span style={{ position: 'relative', color: theme.ink }}>{children}</span>
    </div>
  );
}

function ChangeShot() {
  const { theme } = useFilm();
  const frame = useCurrentFrame();
  const enter = tween(frame, [0, 16], [0, 1]);
  const strike = tween(frame, [38, 56], [0, 1]);
  const tag = pop(frame - 32);
  return (
    <Shell frames={SCENE_FRAMES.change}>
      <Caption>
        {EXAMPLE.provider} retires {EXAMPLE.oldMethod}.
      </Caption>
      <Panel
        box={{ x: 300, y: 205, width: 680, height: 330 }}
        style={{ opacity: enter, transform: `translateY(${(1 - enter) * 60}px)` }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '26px 32px',
            borderBottom: `1px solid ${theme.line}`,
            color: theme.muted,
            fontSize: 21,
          }}
        >
          <img src={apiLogos.slack} alt="" style={{ width: 30, height: 30 }} />
          {EXAMPLE.provider} API changelog
          <Pill
            color={theme.accent}
            background={theme.tint}
            style={{ marginLeft: 'auto', fontFamily: theme.mono }}
          >
            Web API
          </Pill>
        </div>
        <div style={{ display: 'grid', gap: 22, padding: '42px 32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <span
              style={{
                position: 'relative',
                color: theme.ink,
                fontFamily: theme.mono,
                fontSize: 30,
              }}
            >
              {EXAMPLE.oldMethod}
              <span
                style={{
                  position: 'absolute',
                  top: '52%',
                  left: 0,
                  width: `${strike * 100}%`,
                  height: 3,
                  background: theme.removed,
                }}
              />
            </span>
            <Pill
              color={theme.removed}
              background={theme.removedBg}
              style={{ opacity: Math.min(tag, 1), transform: `scale(${0.6 + 0.4 * tag})` }}
            >
              Retired
            </Pill>
          </div>
          <div
            style={{ color: theme.muted, fontSize: 24, opacity: tween(frame, [48, 62], [0, 1]) }}
          >
            Use{' '}
            <span style={{ color: theme.ink, fontFamily: theme.mono }}>{EXAMPLE.newMethod}</span>{' '}
            instead.
          </div>
        </div>
      </Panel>
    </Shell>
  );
}

function FindShot() {
  const { theme } = useFilm();
  const frame = useCurrentFrame();
  const enter = tween(frame, [0, 16], [0, 1]);
  const scan = tween(frame, [18, 72], [0, CODE.length * LINE], easeInOut);
  // Each line lights up as the scan passes it.
  const reached = (index: number) => {
    const at = 18 + (((index + 0.6) * LINE) / (CODE.length * LINE)) * 54;
    return tween(frame, [at, at + 6], [0, 1]);
  };
  const chip = pop(frame - 80);
  return (
    <Shell frames={SCENE_FRAMES.find}>
      <Caption>Refit finds your code.</Caption>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: enter,
          transform: `translateY(${(1 - enter) * 40}px)`,
        }}
      >
        <Editor
          badge={
            <Pill
              color={theme.accentInk}
              background={theme.accent}
              style={{ opacity: Math.min(chip, 1), transform: `scale(${0.6 + 0.4 * chip})` }}
            >
              1 call site
            </Pill>
          }
        >
          {CALL_SITES.map((index) => (
            <div
              key={index}
              style={{
                position: 'absolute',
                top: CODE_TOP + index * LINE,
                right: 0,
                left: 0,
                height: LINE,
                background: theme.tint,
                opacity: reached(index),
                boxShadow: `inset 3px 0 0 ${theme.accent}`,
              }}
            />
          ))}
          {CODE.map((text, index) => (
            <Row key={index} index={index}>
              <Code text={text} />
            </Row>
          ))}
          <Pill
            color={theme.removed}
            background={theme.removedBg}
            style={{
              position: 'absolute',
              top: CODE_TOP + CALL_SITES[0] * LINE + 2,
              right: 24,
              fontSize: 16,
              opacity: reached(CALL_SITES[0]),
            }}
          >
            retired
          </Pill>
          <div
            style={{
              position: 'absolute',
              top: CODE_TOP + scan - LINE,
              right: 0,
              left: 0,
              height: LINE,
              borderBottom: `2px solid ${theme.accent}`,
              background: `linear-gradient(transparent, ${theme.tint})`,
              opacity: tween(frame, [70, 82], [1, 0]) * tween(frame, [16, 22], [0, 1]),
            }}
          />
        </Editor>
      </div>
    </Shell>
  );
}

function FixShot() {
  const { theme } = useFilm();
  const frame = useCurrentFrame();
  const strike = tween(frame, [20, 34], [0, 1]);
  const out = tween(frame, [40, 50], [0, 1]);
  const enter = tween(frame, [44, 52], [0, 1]);
  const typed = Math.floor(
    interpolate(frame, [48, 92], [0, ADDED[0].length + ADDED[1].length], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  const chip = pop(frame - 94);
  return (
    <Shell frames={SCENE_FRAMES.fix}>
      <Caption>It writes the fix.</Caption>
      <Editor
        badge={
          <Pill
            color={theme.accentInk}
            background={theme.accent}
            style={{
              opacity: Math.min(chip, 1),
              transform: `scale(${0.6 + 0.4 * chip})`,
              fontFamily: theme.mono,
            }}
          >
            +2 −2
          </Pill>
        }
      >
        {CODE.map((text, index) => {
          if (CALL_SITES.includes(index)) {
            const added = ADDED[index - CALL_SITES[0]];
            const shown = index === CALL_SITES[0] ? typed : typed - ADDED[0].length;
            return (
              <div key={index}>
                <Row
                  index={index}
                  sign="−"
                  signColor={theme.removed}
                  style={{
                    background: `color-mix(in srgb, ${theme.removedBg} ${strike * 100}%, transparent)`,
                    opacity: 1 - out,
                    transform: `translateY(${-out * 8}px)`,
                  }}
                >
                  <Code text={text} />
                  <span
                    style={{
                      position: 'absolute',
                      top: '50%',
                      left: 0,
                      width: `${strike * 100}%`,
                      height: 2,
                      background: theme.removed,
                    }}
                  />
                </Row>
                <Row
                  index={index}
                  sign="+"
                  signColor={theme.added}
                  style={{
                    background: theme.addedBg,
                    opacity: enter,
                    transform: `translateY(${(1 - enter) * 8}px)`,
                  }}
                >
                  <Code text={added.slice(0, Math.max(0, shown))} />
                  {shown > 0 && shown < added.length && (
                    <span
                      style={{
                        display: 'inline-block',
                        width: 2,
                        height: 22,
                        marginLeft: 1,
                        background: theme.ink,
                      }}
                    />
                  )}
                </Row>
              </div>
            );
          }
          return (
            <Row key={index} index={index}>
              <Code text={text} />
            </Row>
          );
        })}
      </Editor>
    </Shell>
  );
}

const CHECKS_DONE = [44, 58, 72];

function ProveShot() {
  const { theme } = useFilm();
  const frame = useCurrentFrame();
  const enter = tween(frame, [0, 16], [0, 1]);
  const progress = tween(frame, [22, 74], [0, 1], easeInOut);
  const footer = tween(frame, [78, 92], [0, 1]);
  const cell: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, fontSize: 22 };
  return (
    <Shell frames={SCENE_FRAMES.prove}>
      <Caption>It proves it works.</Caption>
      <Panel
        box={{ x: 290, y: 178, width: 700, height: 430 }}
        style={{
          opacity: enter,
          transform: `translateY(${(1 - enter) * 40}px)`,
          padding: '28px 34px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: theme.muted,
            fontSize: 19,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20">
            <path
              d="M10 1.5l7 3v5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9v-5z"
              fill="none"
              stroke={theme.muted}
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
          Sandboxed copy
          <span
            style={{
              marginLeft: 'auto',
              width: 220,
              height: 6,
              borderRadius: 3,
              background: theme.line,
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'block',
                width: `${progress * 100}%`,
                height: '100%',
                background: theme.accent,
              }}
            />
          </span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.2fr 1fr 1fr',
            rowGap: 24,
            marginTop: 30,
            color: theme.ink,
          }}
        >
          {['Check', 'Before', 'After'].map((heading) => (
            <span key={heading} style={{ color: theme.muted, fontSize: 17 }}>
              {heading}
            </span>
          ))}
          {EXAMPLE.checks.map((check, index) => {
            const before = tween(frame, [8 + index * 4, 16 + index * 4], [0, 1]);
            const done = frame >= CHECKS_DONE[index];
            const landed = pop(frame - CHECKS_DONE[index]);
            return [
              <span key={`${check.name}-name`} style={{ ...cell, fontWeight: 600 }}>
                {check.name}
              </span>,
              <span key={`${check.name}-before`} style={{ ...cell, opacity: before }}>
                <CheckIcon color={theme.pass} />
                {check.before}
              </span>,
              <span key={`${check.name}-after`} style={cell}>
                {done ? (
                  <span
                    style={{
                      display: 'flex',
                      transform: `scale(${0.5 + 0.5 * Math.min(landed, 1.1)})`,
                    }}
                  >
                    <CheckIcon color={theme.pass} />
                  </span>
                ) : (
                  <Spinner color={theme.accent} track={theme.line} />
                )}
                <span style={{ color: done ? theme.ink : theme.muted }}>
                  {done ? check.after : 'running'}
                </span>
              </span>,
            ];
          })}
        </div>
        <div
          style={{
            position: 'absolute',
            right: 34,
            bottom: 30,
            left: 34,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            paddingTop: 22,
            borderTop: `1px solid ${theme.line}`,
            color: theme.accent,
            fontSize: 22,
            fontWeight: 600,
            opacity: footer,
            transform: `translateY(${(1 - footer) * 12}px)`,
          }}
        >
          <CheckIcon color={theme.accent} />
          No new failures
        </div>
      </Panel>
    </Shell>
  );
}

function ShipShot() {
  const { theme } = useFilm();
  const frame = useCurrentFrame();
  const card = pop(frame - 2);
  const row = (index: number) => tween(frame, [26 + index * 8, 38 + index * 8], [0, 1]);
  const handoff = tween(frame, [56, 68], [0, 1]);
  const rows: { icon: ReactNode; text: string }[] = [
    {
      icon: <CheckIcon size={22} color={theme.pass} />,
      text: 'Type check, build and tests pass before and after',
    },
    {
      icon: <CheckIcon size={22} color={theme.pass} />,
      text: `Source: ${EXAMPLE.provider} API changelog`,
    },
    {
      icon: <WarnIcon size={22} color={theme.warn} />,
      text: 'Unproven: callers that pass several channels',
    },
  ];
  return (
    <Shell frames={SCENE_FRAMES.ship}>
      <Caption>It opens a pull request.</Caption>
      <Panel
        box={{ x: 250, y: 160, width: 780, height: 450 }}
        style={{
          padding: '30px 36px',
          opacity: Math.min(card, 1),
          transform: `translateY(${(1 - Math.min(card, 1)) * 70}px) scale(${0.96 + 0.04 * card})`,
        }}
      >
        <div style={{ display: 'flex', gap: 10 }}>
          <Pill color={theme.panel} background={theme.muted}>
            Draft
          </Pill>
          <Pill
            color={theme.pass}
            background="transparent"
            style={{ boxShadow: `inset 0 0 0 1.5px ${theme.pass}` }}
          >
            <CheckIcon size={18} color={theme.pass} />
            Verified
          </Pill>
        </div>
        <div
          style={{
            marginTop: 18,
            color: theme.ink,
            fontSize: 30,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            lineHeight: 1.25,
          }}
        >
          {EXAMPLE.title}{' '}
          <span style={{ color: theme.muted, fontWeight: 400 }}>#{EXAMPLE.number}</span>
        </div>
        <div style={{ marginTop: 10, color: theme.muted, fontSize: 18 }}>
          refit-agent wants to merge 1 commit into main from{' '}
          <span style={{ fontFamily: theme.mono }}>{EXAMPLE.branch}</span>
        </div>
        <div
          style={{
            display: 'grid',
            gap: 16,
            marginTop: 26,
            paddingTop: 24,
            borderTop: `1px solid ${theme.line}`,
          }}
        >
          {rows.map((entry, index) => (
            <div
              key={entry.text}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                color: theme.ink,
                fontSize: 20,
                opacity: row(index),
                transform: `translateX(${(1 - row(index)) * -16}px)`,
              }}
            >
              {entry.icon}
              {entry.text}
            </div>
          ))}
        </div>
        <div
          style={{
            position: 'absolute',
            right: 36,
            bottom: 30,
            left: 36,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: theme.accent,
            fontSize: 19,
            fontWeight: 600,
            opacity: handoff,
            transform: `translateY(${(1 - handoff) * 10}px)`,
          }}
        >
          <Spinner color={theme.accent} track={theme.line} />
          Sending it to your coding agent
        </div>
      </Panel>
    </Shell>
  );
}

const AGENT_NOTE = `${EXAMPLE.provider} retired ${EXAMPLE.oldMethod}, so Refit moved sendReport to ${EXAMPLE.newMethod} and channels to channel_id. Type check, build and tests pass. Heads up: it now posts to one channel per call.`;
const REPLY = 108;
const MERGED = 128;

// The developer's own coding agent gets the pull request from Refit and explains it in their
// session, so nobody stops to review it by hand.
function BriefShot() {
  const { theme } = useFilm();
  const frame = useCurrentFrame();
  const enter = tween(frame, [0, 16], [0, 1]);
  const notice = tween(frame, [8, 20], [0, 1]);
  const typed = Math.floor(
    interpolate(frame, [26, 88], [0, AGENT_NOTE.length], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  const reply = pop(frame - REPLY);
  const merged = tween(frame, [MERGED, MERGED + 10], [0, 1]);
  const label: CSSProperties = { color: theme.muted, fontSize: 16, marginBottom: 6 };
  return (
    <Shell frames={SCENE_FRAMES.brief}>
      <Caption until={REPLY - 6}>Your agent explains it.</Caption>
      <Caption from={REPLY}>No review queue.</Caption>
      <Panel
        box={{ x: 200, y: 150, width: 880, height: 470 }}
        style={{ opacity: enter, transform: `translateY(${(1 - enter) * 40}px)` }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            height: 52,
            padding: '0 24px',
            borderBottom: `1px solid ${theme.line}`,
            color: theme.muted,
            fontSize: 17,
          }}
        >
          Your coding agent
          <span style={{ marginLeft: 'auto', fontFamily: theme.mono, fontSize: 15 }}>
            ~/{EXAMPLE.repository.split('/')[1]}
          </span>
        </div>
        <div style={{ display: 'grid', gap: 18, padding: '24px 30px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 16px',
              borderRadius: 10,
              background: theme.tint,
              color: theme.ink,
              fontSize: 19,
              opacity: notice,
              transform: `translateY(${(1 - notice) * 12}px)`,
            }}
          >
            <Mark size={20} color={theme.logo ?? theme.accent} />
            <span style={{ color: theme.logo ?? theme.accent, fontWeight: 600 }}>Refit</span>
            opened draft PR #{EXAMPLE.number}: {EXAMPLE.title}
          </div>
          <div style={{ opacity: tween(frame, [22, 28], [0, 1]) }}>
            <div style={label}>Agent</div>
            <div style={{ minHeight: 90, color: theme.ink, fontSize: 20, lineHeight: 1.5 }}>
              {AGENT_NOTE.slice(0, typed)}
              {typed > 0 && typed < AGENT_NOTE.length && (
                <span
                  style={{
                    display: 'inline-block',
                    width: 9,
                    height: 20,
                    marginLeft: 2,
                    verticalAlign: -3,
                    background: theme.accent,
                  }}
                />
              )}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <span
              style={{
                padding: '10px 18px',
                borderRadius: '16px 16px 4px 16px',
                color: theme.accentInk,
                background: theme.accent,
                fontSize: 19,
                fontWeight: 600,
                opacity: Math.min(reply, 1),
                transform: `scale(${0.8 + 0.2 * Math.min(reply, 1.05)})`,
                transformOrigin: 'bottom right',
              }}
            >
              Looks good. Merge it.
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: theme.ink,
              fontSize: 20,
              opacity: merged,
              transform: `translateY(${(1 - merged) * 10}px)`,
            }}
          >
            <CheckIcon size={22} color={theme.pass} />
            Merged #{EXAMPLE.number}. Back to what you were doing.
          </div>
        </div>
      </Panel>
    </Shell>
  );
}

function EndShot() {
  const { theme, tagline } = useFilm();
  const frame = useCurrentFrame();
  const mark = pop(frame - 4);
  return (
    <Shell frames={SCENE_FRAMES.end}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 22,
            opacity: Math.min(mark, 1),
            transform: `scale(${0.88 + 0.12 * mark})`,
          }}
        >
          <Mark size={80} color={theme.logo ?? theme.accent} />
          <span
            style={{ color: theme.ink, fontSize: 104, fontWeight: 700, letterSpacing: '-0.05em' }}
          >
            Refit
          </span>
        </div>
        <div style={{ color: theme.muted, fontSize: 34, opacity: tween(frame, [14, 30], [0, 1]) }}>
          {tagline}
        </div>
      </AbsoluteFill>
    </Shell>
  );
}

const SHOTS: Record<SceneId, () => ReactNode> = {
  change: ChangeShot,
  find: FindShot,
  fix: FixShot,
  prove: ProveShot,
  ship: ShipShot,
  brief: BriefShot,
  end: EndShot,
};

function Stage({ theme, children }: { theme: FilmTheme; children: ReactNode }) {
  return (
    <AbsoluteFill style={{ background: theme.bg, color: theme.ink, fontFamily: theme.sans }}>
      {children}
    </AbsoluteFill>
  );
}

type FilmProps = { theme: FilmTheme; tagline: string };

function RefitFilm({ theme, tagline }: FilmProps) {
  return (
    <FilmContext.Provider value={{ theme, tagline, captions: true }}>
      <Stage theme={theme}>
        {ORDER.map((id) => {
          const Shot = SHOTS[id];
          return (
            <Sequence key={id} from={STARTS[id]} durationInFrames={SCENE_FRAMES[id]}>
              <Shot />
            </Sequence>
          );
        })}
        <span
          style={{ position: 'absolute', right: 30, bottom: 22, color: theme.muted, fontSize: 16 }}
        >
          Illustrative example
        </span>
      </Stage>
    </FilmContext.Provider>
  );
}

type ClipProps = { theme: FilmTheme; scene: SceneId };

function SceneClip({ theme, scene }: ClipProps) {
  const Shot = SHOTS[scene];
  return (
    <FilmContext.Provider value={{ theme, tagline: '', captions: false }}>
      <Stage theme={theme}>
        {/* Without a caption there's room to frame the shot tighter; every panel still fits. */}
        <AbsoluteFill style={{ transform: 'scale(1.3)' }}>
          <Shot />
        </AbsoluteFill>
      </Stage>
    </FilmContext.Provider>
  );
}

function themeVariables(theme: FilmTheme) {
  return {
    '--film-ink': theme.ink,
    '--film-muted': theme.muted,
    '--film-line': theme.line,
    '--film-panel': theme.panel,
    '--film-accent': theme.accent,
    '--film-sans': theme.sans,
    '--film-mono': theme.mono,
    '--film-radius': `${theme.radius}px`,
  } as CSSProperties;
}

// Follows the player's frame and play state, and pauses it while it's off screen.
function usePlayback(
  player: RefObject<PlayerRef | null>,
  root: RefObject<HTMLElement | null>,
  initialFrame: number,
  // How much of the player must be on screen before it plays; null when the page decides.
  visible: number | null = 0.15,
) {
  const [frame, setFrame] = useState(initialFrame);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const current = player.current;
    if (!current) return;
    const onFrame: CallbackListener<'frameupdate'> = (event) => setFrame(event.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    current.addEventListener('frameupdate', onFrame);
    current.addEventListener('play', onPlay);
    current.addEventListener('pause', onPause);
    // Autoplay can start before these listeners exist.
    setPlaying(current.isPlaying());
    let resume = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && current.isPlaying()) {
          resume = true;
          current.pause();
        } else if (entry.isIntersecting && resume) {
          resume = false;
          current.play();
        }
      },
      { threshold: visible ?? 0 },
    );
    if (visible !== null) observer.observe(root.current!);
    return () => {
      observer.disconnect();
      current.removeEventListener('frameupdate', onFrame);
      current.removeEventListener('play', onPlay);
      current.removeEventListener('pause', onPause);
    };
  }, [player, root, visible]);
  return { frame, playing };
}

function ToggleButton({
  playing,
  onClick,
  label,
  className,
}: {
  playing: boolean;
  onClick: () => void;
  label: string;
  className: string;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-label={`${playing ? 'Pause' : 'Play'} ${label}`}
    >
      {playing ? <Pause weight="fill" /> : <Play weight="fill" />}
    </button>
  );
}

function Timeline({ frame, onSeek }: { frame: number; onSeek: (frame: number) => void }) {
  const seconds = Math.floor(FILM_FRAMES / FPS);
  const seekFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(Math.round(((event.clientX - box.left) / box.width) * (FILM_FRAMES - 1)));
  };
  return (
    <div className="film-timeline" style={{ '--playhead': frame / FILM_FRAMES } as CSSProperties}>
      <div className="film-ruler" onPointerDown={seekFromPointer} aria-hidden="true">
        {Array.from({ length: Math.floor(seconds / 2) + 1 }, (_, index) => (
          <span key={index} style={{ left: `${((index * 2 * FPS) / FILM_FRAMES) * 100}%` }}>
            {index * 2}s
          </span>
        ))}
      </div>
      {CHAPTERS.map((chapter, index) => (
        <div
          className="film-track"
          key={chapter.label}
          style={{ '--track': index } as CSSProperties}
        >
          <span className="film-track-name">{chapter.label}</span>
          <div className="film-track-lane">
            <button
              type="button"
              className="film-track-clip"
              aria-current={frame >= chapter.from && frame < chapter.to ? 'step' : undefined}
              style={{
                left: `${(chapter.from / FILM_FRAMES) * 100}%`,
                width: `${((chapter.to - chapter.from) / FILM_FRAMES) * 100}%`,
              }}
              onClick={() => onSeek(chapter.from)}
            >
              {chapter.label}
            </button>
          </div>
        </div>
      ))}
      <span className="film-playhead" aria-hidden="true" />
    </div>
  );
}

function timecode(frame: number) {
  const total = Math.floor(frame / FPS);
  return `00:${String(total).padStart(2, '0')}:${String(frame % FPS).padStart(2, '0')}`;
}

// The full film with chapter buttons under it, or a track timeline for the editor direction.
export function FilmPlayer({
  theme,
  tagline = 'Stop chasing API changelogs.',
  controls = 'chapters',
  className = '',
  playWhenVisible,
}: {
  theme: FilmTheme;
  tagline?: string;
  controls?: 'chapters' | 'timeline';
  className?: string;
  playWhenVisible?: number;
}) {
  const player = useRef<PlayerRef>(null);
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { frame, playing } = usePlayback(player, root, reduced ? POSTER_FRAME : 0, playWhenVisible);
  const seek = (to: number) => player.current?.seekTo(to);
  const toggle = () => player.current?.toggle();
  return (
    <div
      ref={root}
      className={`film ${className}`}
      style={themeVariables(theme)}
      role="region"
      aria-label="Illustrative demo: Refit fixes a Slack API change"
    >
      <Player
        ref={player}
        component={RefitFilm}
        inputProps={{ theme, tagline }}
        durationInFrames={FILM_FRAMES}
        fps={FPS}
        compositionWidth={WIDTH}
        compositionHeight={HEIGHT}
        style={{ width: '100%', borderRadius: theme.radius, overflow: 'hidden' }}
        autoPlay={!reduced}
        initialFrame={reduced ? POSTER_FRAME : 0}
        loop
        clickToPlay
        // The films are silent. Unmuted, the player times playback on an AudioContext, which browsers
        // keep suspended until a click, so clips sat frozen while showing "playing".
        initiallyMuted
        numberOfSharedAudioTags={0}
        acknowledgeRemotionLicense
      />
      {controls === 'chapters' ? (
        <div className="film-bar">
          <ToggleButton
            playing={playing}
            onClick={toggle}
            label="the demo"
            className="film-toggle"
          />
          <ol className="film-chapters">
            {CHAPTERS.map((chapter) => (
              <li key={chapter.label}>
                <button
                  type="button"
                  aria-current={frame >= chapter.from && frame < chapter.to ? 'step' : undefined}
                  style={
                    {
                      '--progress': Math.min(
                        1,
                        Math.max(0, (frame - chapter.from) / (chapter.to - chapter.from)),
                      ),
                    } as CSSProperties
                  }
                  onClick={() => seek(chapter.from)}
                >
                  {chapter.label}
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="film-bar">
          <ToggleButton
            playing={playing}
            onClick={toggle}
            label="the demo"
            className="film-toggle"
          />
          <span className="film-timecode">
            {timecode(frame)} <span>/ {timecode(FILM_FRAMES)}</span>
          </span>
          <Timeline frame={frame} onSeek={seek} />
        </div>
      )}
    </div>
  );
}

// Any composition on a loop, with its own pause button: a film shot or a page's own animation.
export function LoopPlayer<Props extends Record<string, unknown>>({
  component,
  inputProps,
  frames,
  size = { width: WIDTH, height: HEIGHT },
  rest,
  label,
  theme,
  className = '',
  active,
  start = 0,
  onEnd,
}: {
  component: ComponentType<Props>;
  inputProps: Props;
  frames: number;
  size?: { width: number; height: number };
  // The frame shown, still, under reduced motion and before a controlled clip first plays.
  rest: number;
  label: string;
  theme: FilmTheme;
  className?: string;
  // When set, the page decides: the clip plays once from `start` when it becomes active, then
  // holds on its rest frame, and goes back to its rest frame when it stops being active.
  active?: boolean;
  // Where the clip starts, and where a looping one first plays from.
  start?: number;
  // Called when an active clip has played through.
  onEnd?: () => void;
}) {
  const player = useRef<PlayerRef>(null);
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const controlled = active !== undefined;
  const still = reduced || controlled;
  const { playing } = usePlayback(
    player,
    root,
    still ? rest : start,
    controlled ? null : undefined,
  );
  useEffect(() => {
    const current = player.current;
    if (!current || !controlled || reduced) return;
    // Pausing first, or a seek mid-play leaves the player set to resume on its own later.
    current.pause();
    current.seekTo(active ? start : rest);
    if (active) current.play();
  }, [active, controlled, reduced, start, rest]);
  useEffect(() => {
    const current = player.current;
    if (!current || !onEnd) return;
    current.addEventListener('ended', onEnd);
    return () => current.removeEventListener('ended', onEnd);
  }, [onEnd]);
  const toggle = () => {
    const current = player.current!;
    // A clip that has played through starts again.
    if (controlled && !current.isPlaying() && current.getCurrentFrame() >= rest)
      current.seekTo(start);
    current.toggle();
  };
  return (
    <div
      ref={root}
      className={`clip ${className}`}
      style={themeVariables(theme)}
      data-playing={playing}
    >
      <Player
        ref={player}
        component={component}
        inputProps={inputProps}
        durationInFrames={frames}
        fps={FPS}
        compositionWidth={size.width}
        compositionHeight={size.height}
        style={{ width: '100%' }}
        autoPlay={!still}
        initialFrame={still ? rest : start}
        loop={!controlled}
        outFrame={controlled ? rest : undefined}
        moveToBeginningWhenEnded={!controlled}
        // Silent, like FilmPlayer: muted keeps playback off the click-gated AudioContext.
        initiallyMuted
        numberOfSharedAudioTags={0}
        acknowledgeRemotionLicense
      />
      <ToggleButton playing={playing} onClick={toggle} label={label} className="clip-toggle" />
    </div>
  );
}

// One shot on a loop, without captions, for tiles that carry their own words.
export function ClipPlayer({
  scene,
  theme,
  label,
  active,
  onEnd,
}: {
  scene: SceneId;
  theme: FilmTheme;
  label: string;
  active?: boolean;
  onEnd?: () => void;
}) {
  return (
    <LoopPlayer
      component={SceneClip}
      inputProps={{ theme, scene }}
      frames={SCENE_FRAMES[scene]}
      rest={clipRest(scene)}
      label={label}
      theme={theme}
      active={active}
      start={CLIP_START}
      onEnd={onEnd}
    />
  );
}
