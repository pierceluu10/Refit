import {
  ArrowRight,
  ArrowsClockwise,
  BracketsCurly,
  Check,
  CheckCircle,
  Eye,
  FileCode,
  GitPullRequest,
  MagnifyingGlass,
  Pause,
  Play,
  ShieldCheck,
  WarningCircle,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { stages, STEP_DURATION } from '../data';
import type { Scenario } from '../data';
import { Mark } from './Brand';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

const stageIcons = [MagnifyingGlass, Eye, ShieldCheck, GitPullRequest];
const FINAL_STAGE = stages.length - 1;
const stageSubtitles = [
  'API usage map',
  'Provider change',
  'Checks before and after',
  'Pull request',
];

function CodeDiff() {
  return (
    <div className="code-diff" aria-label="Illustrative TypeScript migration diff" tabIndex={0}>
      <div className="code-line">
        <span className="line-number">12</span>
        <code>
          <span className="syntax-purple">const</span> payment ={' '}
          <span className="syntax-purple">await</span> stripe.paymentIntents.retrieve(id);
        </code>
      </div>
      <div className="code-line">
        <span className="line-number">13</span>
        <code> </code>
      </div>
      <div className="code-line removed">
        <span className="line-number">14</span>
        <code>
          <span className="diff-sign">−</span> <span className="syntax-purple">const</span> charge =
          payment.charges.data[0];
        </code>
      </div>
      <div className="code-line added">
        <span className="line-number">14</span>
        <code>
          <span className="diff-sign">+</span> <span className="syntax-purple">const</span> charge =
          payment.latest_charge;
        </code>
      </div>
      <div className="code-line added">
        <span className="line-number">15</span>
        <code>
          <span className="diff-sign">+</span> <span className="syntax-purple">const</span> chargeId
          = <span className="syntax-purple">typeof</span> charge ==={' '}
          <span className="syntax-green">'string'</span>
        </code>
      </div>
      <div className="code-line added">
        <span className="line-number">16</span>
        <code>
          <span className="diff-sign">+</span> ? charge : charge?.id ??{' '}
          <span className="syntax-purple">null</span>;
        </code>
      </div>
      <div className="code-line">
        <span className="line-number">17</span>
        <code> </code>
      </div>
      <div className="code-line">
        <span className="line-number">18</span>
        <code>
          <span className="syntax-purple">return</span> {'{'} paymentId: payment.id, chargeId {'}'};
        </code>
      </div>
    </div>
  );
}

const affectedUsage = [
  { fact: 'Stripe via SDK', value: 'stripe-node' },
  { fact: 'Pinned apiVersion', value: 'src/lib/stripe.ts:4' },
  { fact: 'paymentIntents.retrieve', value: 'src/billing/payments.ts:12' },
  { fact: 'Reads charges.data[0]', value: 'src/billing/payments.ts:14' },
];
const usageMaps: Record<Scenario, typeof affectedUsage> = {
  affected: affectedUsage,
  failed: affectedUsage,
  unaffected: [
    { fact: 'Stripe via SDK', value: 'stripe-node' },
    { fact: 'Pinned apiVersion', value: 'src/lib/stripe.ts:4' },
    { fact: 'checkout.sessions.create', value: 'src/checkout/create-session.ts:8' },
    { fact: 'Reads session.url', value: 'src/checkout/create-session.ts:9' },
  ],
};

const checks = ['npm run typecheck', 'npm run build', 'npm test'];
const FAILING_CHECK = checks.length - 1;

function StageContent({ stage, scenario = 'affected' }: { stage: number; scenario?: Scenario }) {
  if (stage === 0)
    return (
      <div className="usage-content">
        <div className="artifact-label">
          <MagnifyingGlass /> API usage map <span>Illustrative evidence</span>
        </div>
        <div className="evidence-trace">
          <span>checkout route</span>
          <ArrowRight />
          <span>PaymentService</span>
          <ArrowRight />
          <span className="trace-active">StripeGateway</span>
        </div>
        <div className="check-list">
          {usageMaps[scenario].map((row) => (
            <div key={row.fact}>
              <span>{row.fact}</span>
              <code>{row.value}</code>
            </div>
          ))}
        </div>
        <p>
          The agent reads each repository like a new engineer. It records every external API it
          finds, not only the ones a scanner knows.
        </p>
      </div>
    );
  if (stage === 1)
    return (
      <div className="spec-content">
        <div className="artifact-label">
          <BracketsCurly /> Stripe changelog <span>Example change</span>
        </div>
        <h2>
          A field changes.
          <br />
          The impact travels.
        </h2>
        <div className="schema-change">
          <code>payment_intent.charges</code>
          <ArrowRight />
          <code>payment_intent.latest_charge</code>
        </div>
        <p>
          An agent reads the provider’s changelog, records the change with its source, and decides
          which of your call sites it touches.
        </p>
        <a
          href="https://docs.stripe.com/api/payment_intents/object"
          target="_blank"
          rel="noreferrer"
        >
          Read Stripe’s current PaymentIntent reference <ArrowRight size={14} />
        </a>
      </div>
    );
  if (scenario === 'unaffected')
    return (
      <div className="result-panel">
        <CheckCircle size={32} weight="duotone" className="positive" />
        <h2>Not affected</h2>
        <p>
          The sample checkout code creates a session. It never reads <code>payment.charges</code>.
        </p>
        <div className="inline-notice">
          The verdict is recorded with its reason. No migration or pull request is needed in this
          example.
        </div>
        <code className="standalone-code">stripe.checkout.sessions.create(options)</code>
      </div>
    );
  const failed = scenario === 'failed';
  if (stage === 2)
    return (
      <div className="validation-content">
        <div className="artifact-label">
          <ShieldCheck /> Sandbox run <span>Illustrative outcome</span>
        </div>
        <CodeDiff />
        <div className="check-list">
          {checks.map((command, index) => (
            <div key={command}>
              <code>{command}</code>
              <span className={failed && index === FAILING_CHECK ? 'negative' : 'positive'}>
                {failed && index === FAILING_CHECK ? (
                  <>
                    <WarningCircle /> Example failure
                  </>
                ) : (
                  <>
                    <Check /> Example pass
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
        <p>
          {failed
            ? 'A new failure after the edit. The agent keeps iterating, and says why in the PR if it still can’t make it pass.'
            : 'Checks run before and after the edit. Only new failures count. This preview does not execute them.'}
        </p>
      </div>
    );
  return (
    <div className="review-content">
      <div className="artifact-label">
        <GitPullRequest /> Pull request <span>Preview only</span>
      </div>
      <h2>Adapt payment charge lookup</h2>
      <div className="review-meta">
        <span className={`draft-badge ${failed ? 'badge-warning' : ''}`}>
          {failed ? 'Needs review' : 'Verified'}
        </span>
        <code>refit/stripe/charge-reference</code>
      </div>
      <p>
        What changed and why, the proof, and what is unproven, in one place. Refit never merges and
        never pushes to your default branch.
      </p>
      <div className="review-summary">
        <span>
          <FileCode /> 1 example file
        </span>
        <span className="positive">+3</span>
        <span className="negative">−1</span>
        <span>Human review required</span>
      </div>
      {failed ? (
        <div className="inline-notice notice-warning">
          Unproven: <code>npm test</code> still fails one example assertion. The PR says which one
          and why.
        </div>
      ) : (
        <div className="inline-notice">
          This is an illustration. No repository was accessed and no PR was created.
        </div>
      )}
    </div>
  );
}

export function Workflow({
  expanded = false,
  scenario = 'affected',
}: {
  expanded?: boolean;
  scenario?: Scenario;
}) {
  const [stage, setStage] = useState(expanded ? 0 : 1);
  const reducedMotion = useReducedMotion();
  const [playing, setPlaying] = useState(!expanded && !reducedMotion);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(!document.hidden);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.2,
    });
    if (container.current) observer.observe(container.current);
    const updateVisibility = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);
  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);
  useEffect(() => {
    if (!playing || !visible || !foreground) return;
    const timeout = setTimeout(() => {
      if (stage >= FINAL_STAGE) setPlaying(false);
      else setStage(stage + 1);
    }, STEP_DURATION);
    return () => clearTimeout(timeout);
  }, [playing, stage, visible, foreground]);

  function selectStage(index: number) {
    setPlaying(false);
    setStage(index);
  }
  function play() {
    if (stage === FINAL_STAGE) setStage(0);
    setPlaying(!playing);
  }

  return (
    <div className={`workflow ${expanded ? 'workflow-expanded' : ''}`} ref={container}>
      {!expanded && (
        <div
          className={`workflow-map ${playing && visible && foreground ? 'is-playing' : ''}`}
          style={{ '--step-duration': `${STEP_DURATION}ms` } as CSSProperties}
          aria-hidden="true"
        >
          <svg className="workflow-lines" viewBox="0 0 960 160" preserveAspectRatio="none">
            <path d="M205 80H365Q385 80 385 60V55Q385 35 405 35H450" />
            <path d="M510 35H555Q575 35 575 55V60Q575 80 595 80H755" />
            <path className="signal-line" d="M205 80H365Q385 80 385 60V55Q385 35 405 35H450" />
          </svg>
          <div className="map-endpoint map-source">
            <div className="provider-symbol">S</div>
            <div>
              <strong>API change</strong>
              <span>stripe / changelog</span>
            </div>
            <span className="map-dot" />
          </div>
          <div className="map-center">
            <div className="engine-node">
              <Mark />
            </div>
            <span>refit</span>
          </div>
          <div className="map-endpoint map-output">
            <GitPullRequest size={24} />
            <div>
              <strong>Pull request</strong>
              <span>Verified or needs review</span>
            </div>
          </div>
          <div className="map-caption">From upstream change to downstream fix.</div>
        </div>
      )}
      <div className="workflow-window">
        <div className="window-bar">
          <div className="window-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <span>
            <FileCode size={14} /> {expanded ? 'Refit / interactive walkthrough' : 'acme / api'}
          </span>
          <span className="preview-label">Illustrative example</span>
        </div>
        <div className="workflow-body">
          <div className="workflow-steps" aria-label="Migration stages">
            {stages.map((item, index) => {
              const Icon = stageIcons[index];
              return (
                <button
                  key={item.id}
                  className={`workflow-step ${stage === index ? 'selected' : ''}`}
                  aria-label={`${item.short} ${stageSubtitles[index]}`}
                  aria-pressed={stage === index}
                  onClick={() => selectStage(index)}
                >
                  <span className="stage-icon">
                    <Icon size={18} />
                  </span>
                  <span>
                    <strong>{item.short}</strong>
                    <small>{stageSubtitles[index]}</small>
                  </span>
                  <span className="step-trailing">
                    {index < stage ? <Check size={14} /> : `0${index + 1}`}
                  </span>
                </button>
              );
            })}
            <div className="workflow-controls">
              <button
                onClick={play}
                aria-label={
                  playing
                    ? 'Pause walkthrough'
                    : stage === FINAL_STAGE
                      ? 'Replay walkthrough'
                      : 'Play walkthrough'
                }
              >
                {playing ? (
                  <Pause weight="fill" />
                ) : stage === FINAL_STAGE ? (
                  <ArrowsClockwise />
                ) : (
                  <Play weight="fill" />
                )}
                <span>
                  {playing ? 'Pause' : stage === FINAL_STAGE ? 'Replay' : 'Play walkthrough'}
                </span>
              </button>
            </div>
          </div>
          <div className="workflow-detail" aria-live={playing ? 'off' : 'polite'}>
            <StageContent stage={stage} scenario={scenario} />
          </div>
        </div>
        <div className="window-footer">
          <span>
            <span className="status-dot" /> {playing ? 'Playing example' : 'Interactive preview'}
          </span>
          {expanded ? (
            <span>
              Step {stage + 1} of {stages.length}
            </span>
          ) : (
            <Link to="/demo">
              Explore the workflow <ArrowRight size={13} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
