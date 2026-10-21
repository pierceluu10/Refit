import {
  ArrowRight,
  ArrowsClockwise,
  BracketsCurly,
  Check,
  CheckCircle,
  Code,
  FileCode,
  GitDiff,
  GitPullRequest,
  MagnifyingGlass,
  Pause,
  Play,
  ShieldCheck,
  WarningCircle,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { stages, STEP_DURATION } from '../data';
import type { Scenario } from '../data';
import { WorkflowMap } from './WorkflowMap';

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

const stageIcons = [MagnifyingGlass, Code, ShieldCheck, GitPullRequest];
const FINAL_STAGE = stages.length - 1;
const stageSubtitles = ['Provider change', 'Code impact', 'Project checks', 'Draft pull request'];

export function CodeDiff() {
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

export function StageContent({
  stage,
  scenario = 'affected',
}: {
  stage: number;
  scenario?: Scenario;
}) {
  if (scenario === 'unaffected' && stage > 0)
    return (
      <div className="result-panel">
        <CheckCircle size={32} weight="duotone" className="positive" />
        <h2>No affected usage</h2>
        <p>
          The sample checkout code creates a session. It does not read <code>payment.charges</code>.
        </p>
        <div className="inline-notice">No migration or pull request is needed in this example.</div>
        <code className="standalone-code">stripe.checkout.sessions.create(options)</code>
      </div>
    );
  if (stage === 0)
    return (
      <div className="spec-content">
        <div className="artifact-label">
          <BracketsCurly /> Provider specification <span>Example change</span>
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
        <p>Trace a changed response field from the API contract to the code that consumes it.</p>
        <a
          href="https://docs.stripe.com/api/payment_intents/object"
          target="_blank"
          rel="noreferrer"
        >
          Read Stripe’s current PaymentIntent reference <ArrowRight size={14} />
        </a>
      </div>
    );
  if (stage === 1)
    return (
      <div className="evidence-content">
        <div className="artifact-label">
          <FileCode /> src/billing/payments.ts <span>Illustrative evidence</span>
        </div>
        <div className="evidence-trace">
          <span>checkout route</span>
          <ArrowRight />
          <span>PaymentService</span>
          <ArrowRight />
          <span className="trace-active">StripeGateway</span>
        </div>
        <CodeDiff />
        <p className="artifact-footnote">
          <GitDiff size={15} /> A focused change at the point of use. The surrounding code stays
          yours.
        </p>
      </div>
    );
  if (stage === 2)
    return (
      <div className="validation-content">
        <div className="artifact-label">
          <ShieldCheck /> Validation plan <span>Illustrative outcome</span>
        </div>
        <h2>Your checks set the bar.</h2>
        <div className="check-list">
          {['npm run typecheck', 'npm run lint', 'npm test'].map((command, index) => (
            <div key={command}>
              <code>{command}</code>
              <span className={scenario === 'failed' && index === 2 ? 'negative' : 'positive'}>
                {scenario === 'failed' && index === 2 ? (
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
          {scenario === 'failed'
            ? 'A failed assertion blocks publication. Refit would attempt a bounded repair before returning a failure.'
            : 'In the connected product, these commands run inside an isolated environment. This preview does not execute them.'}
        </p>
      </div>
    );
  if (scenario === 'failed')
    return (
      <div className="result-panel">
        <WarningCircle size={32} className="negative" />
        <h2>No passing checks. No PR.</h2>
        <p>
          The example test still fails after the repair limit. Review the retained diff and failure
          evidence before retrying.
        </p>
        <div className="inline-notice notice-warning">
          Publication is blocked. No pull request was created.
        </div>
      </div>
    );
  return (
    <div className="review-content">
      <div className="artifact-label">
        <GitPullRequest /> Draft pull request <span>Preview only</span>
      </div>
      <h2>Adapt payment charge lookup</h2>
      <div className="review-meta">
        <span className="draft-badge">Draft</span>
        <code>refit/stripe/charge-reference</code>
      </div>
      <p>
        A small, reviewable patch with the provider change, affected code, and validation evidence
        in one place.
      </p>
      <div className="review-summary">
        <span>
          <FileCode /> 1 example file
        </span>
        <span className="positive">+3</span>
        <span className="negative">−1</span>
        <span>Human review required</span>
      </div>
      <div className="inline-notice">
        This is an illustration. No repository was accessed and no PR was created.
      </div>
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
      {!expanded && <WorkflowMap active={visible && foreground && !reducedMotion} />}
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
