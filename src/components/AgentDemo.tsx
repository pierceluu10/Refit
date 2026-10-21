import {
  CheckCircle,
  Circle,
  CircleNotch,
  Cursor,
  FileTs,
  GitPullRequest,
  Pause,
  Play,
} from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Mark } from './Brand';

// One loop of the demo, in milliseconds from its start.
const AT = {
  show: 300,
  toVersion: 700,
  selectVersion: 1700,
  typeVersion: 2050,
  toCharge: 2900,
  selectCharge: 3750,
  typeCharge: 4150,
  checks: 6000,
  toButton: 7500,
  press: 8300,
  pullRequest: 8700,
  fade: 13600,
  loop: 14200,
};
const VERSION_KEY_MS = 45;
const CODE_KEY_MS = 14;
const CHECK_MS = 450;
const PRESS_MS = 180;
const TICK_MS = 40;

const OLD_VERSION = '2022-08-01';
const NEW_VERSION = '2022-11-15';
const ADDED = [
  '  const charge = payment.latest_charge;',
  "  return typeof charge === 'string' ? charge : charge?.id ?? null;",
];
const CHECKS = ['typecheck', 'lint', 'test'];

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

// Enough highlighting for the eleven lines below: keywords and single-quoted strings.
function highlight(text: string) {
  return text.split(/('[^']*'?|\b[a-z]+\b)/).map((part, index) =>
    part.startsWith("'") ? (
      <span key={index} className="token-string">
        {part}
      </span>
    ) : KEYWORDS.has(part) ? (
      <span key={index} className="token-keyword">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

type Target = 'start' | 'version' | 'charge' | 'button';

function targetAt(time: number): Target {
  if (time < AT.toVersion) return 'start';
  if (time < AT.toCharge) return 'version';
  if (time < AT.toButton) return 'charge';
  return 'button';
}

function pressed(time: number) {
  return [AT.selectVersion, AT.selectCharge, AT.press].some(
    (moment) => time >= moment && time < moment + PRESS_MS,
  );
}

function typed(time: number, from: number, perKey: number) {
  return Math.max(0, Math.floor((time - from) / perKey));
}

// An illustrative run of Refit Agent: its cursor moves to the Stripe call a provider change
// breaks, rewrites it, runs the repository's checks and opens a draft pull request. It loops
// while on screen, pauses on request, and shows the finished state under reduced motion.
export function AgentDemo() {
  const root = useRef<HTMLElement>(null);
  const targets = {
    version: useRef<HTMLSpanElement>(null),
    charge: useRef<HTMLSpanElement>(null),
    button: useRef<HTMLSpanElement>(null),
  };
  const [time, setTime] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [point, setPoint] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setReduced(true);
      setTime(AT.fade - 1);
      return;
    }
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting), {
      threshold: 0.3,
    });
    observer.observe(root.current!);
    const timer = window.setInterval(() => {
      if (!visible || document.hidden || paused) return;
      setTime((current) => (current + TICK_MS >= AT.loop ? 0 : current + TICK_MS));
    }, TICK_MS);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [paused]);

  const target = targetAt(time);
  useLayoutEffect(() => {
    const box = root.current!;
    const measure = () => {
      const frame = box.getBoundingClientRect();
      if (target === 'start') return setPoint({ x: frame.width + 24, y: frame.height + 24 });
      const rect = targets[target].current!.getBoundingClientRect();
      setPoint({
        x: rect.left - frame.left + Math.min(rect.width * 0.5, 40),
        y: rect.top - frame.top + rect.height * 0.62,
      });
    };
    measure();
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resized?.observe(box);
    return () => resized?.disconnect();
    // `targets` holds stable refs, so only the target name matters.
  }, [target]);

  const versionTyped = NEW_VERSION.slice(0, typed(time, AT.typeVersion, VERSION_KEY_MS));
  const versionEditing = time >= AT.typeVersion;
  const chargeEditing = time >= AT.typeCharge;
  let budget = typed(time, AT.typeCharge, CODE_KEY_MS);
  const added = ADDED.map((line) => {
    const shown = line.slice(0, Math.max(0, budget));
    budget -= line.length;
    return shown;
  });
  const typing = chargeEditing && budget < 0;
  const checkState = (index: number) => {
    const started = AT.checks + index * CHECK_MS;
    return time < started ? 'idle' : time < started + CHECK_MS ? 'running' : 'passed';
  };
  const opening = time >= AT.press && time < AT.pullRequest;
  const hidden = reduced || time < AT.show || time >= AT.fade;

  return (
    <figure ref={root} className="agent-demo" data-fading={time >= AT.fade || undefined}>
      <figcaption className="sr-only">
        Illustrative example. Stripe API {NEW_VERSION} removes PaymentIntent.charges. Refit Agent
        updates the API version in src/billing/payments.ts, replaces the charges lookup with
        latest_charge, runs typecheck, lint and test, and opens a draft pull request for review.
      </figcaption>
      <div className="agent-stage" aria-hidden="true">
        <div className="agent-window">
          <div className="agent-titlebar">
            <span className="agent-file">
              <FileTs size={15} /> src/billing/payments.ts
            </span>
            <span className="agent-open" ref={targets.button} data-active={opening || undefined}>
              <GitPullRequest size={14} weight="bold" />
              {opening ? 'Opening…' : 'Open draft PR'}
            </span>
          </div>
          <div className="agent-notice">
            <Mark />
            <span>
              Stripe API <code>{NEW_VERSION}</code> removes <code>PaymentIntent.charges</code>
            </span>
          </div>
          <div className="agent-code">
            <Line number={1}>{highlight("import Stripe from 'stripe';")}</Line>
            <Line number={2} />
            <Line number={3}>
              {highlight('const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {')}
            </Line>
            <Line number={4} state={versionEditing ? 'changed' : undefined}>
              {'  apiVersion: '}
              <span
                ref={targets.version}
                className="token-string"
                data-selected={(time >= AT.selectVersion && time < AT.typeVersion) || undefined}
              >
                '{versionEditing ? versionTyped : OLD_VERSION}
                {versionEditing && versionTyped.length < NEW_VERSION.length ? (
                  <span className="agent-caret" />
                ) : (
                  "'"
                )}
              </span>
              ,
            </Line>
            <Line number={5}>{'});'}</Line>
            <Line number={6} />
            <Line number={7}>{highlight('export async function chargeIdFor(id: string) {')}</Line>
            <Line number={8}>
              {highlight('  const payment = await stripe.paymentIntents.retrieve(id);')}
            </Line>
            <div
              className="agent-block"
              data-selected={(time >= AT.selectCharge && time < AT.typeCharge) || undefined}
            >
              <Line number={9} state={chargeEditing ? 'removed' : undefined}>
                {highlight('  const charge = payment.')}
                <span ref={targets.charge}>charges.data[0]</span>;
              </Line>
              <Line number={10} state={chargeEditing ? 'removed' : undefined}>
                {highlight('  return charge?.id ?? null;')}
              </Line>
            </div>
            {chargeEditing &&
              added.map(
                (line, index) =>
                  (index === 0 || line) && (
                    <Line key={index} number={9 + index} state="added">
                      {highlight(line)}
                      {typing && line.length < ADDED[index].length && (
                        <span className="agent-caret" />
                      )}
                    </Line>
                  ),
              )}
            <Line number={11}>{'}'}</Line>
          </div>
          <div className="agent-checks">
            <span>Your checks</span>
            {CHECKS.map((check, index) => {
              const state = checkState(index);
              return (
                <span key={check} className="agent-check" data-state={state}>
                  {state === 'passed' ? (
                    <CheckCircle size={14} weight="fill" />
                  ) : state === 'running' ? (
                    <CircleNotch size={14} weight="bold" />
                  ) : (
                    <Circle size={14} />
                  )}
                  {check}
                </span>
              );
            })}
          </div>
        </div>

        <div className="agent-pr" data-open={time >= AT.pullRequest || undefined}>
          <div className="agent-pr-head">
            <span className="agent-pr-badge">
              <GitPullRequest size={14} weight="bold" /> Draft
            </span>
            <strong>Move PaymentIntent reads to latest_charge</strong>
          </div>
          <p>
            <img src="/refit-agent-avatar-square.png" alt="" /> <b>refit-agent</b> wants to merge 1
            commit into <code>main</code> from <code>refit/stripe-{NEW_VERSION}</code>
          </p>
          <ul>
            <li>
              <CheckCircle size={14} weight="fill" /> typecheck, lint and test passed in isolation
            </li>
            <li>
              <CheckCircle size={14} weight="fill" /> Evidence: Stripe changelog and spec diff
              attached
            </li>
          </ul>
        </div>

        <div
          className="agent-cursor"
          style={{ transform: `translate(${point.x}px, ${point.y}px)` }}
          data-hidden={hidden || undefined}
          data-pressed={pressed(time) || undefined}
          data-flip={target === 'button' || undefined}
        >
          <Cursor size={20} weight="fill" />
          <span className="agent-tag">
            <img src="/refit-agent-avatar-square.png" alt="" /> Refit Agent
          </span>
        </div>
      </div>
      <div className="agent-meta">
        {!reduced && (
          <button
            type="button"
            className="agent-toggle"
            onClick={() => setPaused(!paused)}
            aria-label={paused ? 'Play the demo' : 'Pause the demo'}
          >
            {paused ? <Play size={12} weight="fill" /> : <Pause size={12} weight="fill" />}
          </button>
        )}
      </div>
    </figure>
  );
}

function Line({
  number,
  state,
  children,
}: {
  number: number;
  state?: 'changed' | 'removed' | 'added';
  children?: ReactNode;
}) {
  return (
    <div className="agent-line" data-state={state}>
      <span className="agent-gutter">
        {state === 'removed' ? '−' : state === 'added' ? '+' : number}
      </span>
      <code>{children ?? ' '}</code>
    </div>
  );
}
