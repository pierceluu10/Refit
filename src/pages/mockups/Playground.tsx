import {
  CheckCircle,
  CircleNotch,
  FileTs,
  GitPullRequest,
  Robot,
  Warning,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import { apiLogos } from '../../apiLogos';
import { Mark } from '../../components/Brand';
import { useReducedMotion } from '../../components/Workflow';
import { CHECKS, codebases, scenarios } from './data';
import type { ScenarioId } from './data';

const STEP_MS = 650;
// A run's steps: 1 read the change, 2 trace it, 3 patch, then one per check, then the result.
const TRACED = 2;
const PATCHED = 3;
const FINAL = PATCHED + CHECKS.length + 1;
// Pointer travel, in pixels, before a press on the mark counts as a drag.
const DRAG_START = 4;

type Codebase = (typeof codebases)[number];
type Scenario = (typeof scenarios)[number];

// Pick an API change, then drag the Refit mark onto a repository (or press its Run button). The
// run plays out beside what a coding agent does with the same change. Everything is simulated
// in the browser on illustrative repositories.
export function PlaygroundSection() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('payment');
  const [target, setTarget] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [run, setRun] = useState(0);
  const reduced = useReducedMotion();
  const chip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());

  const scenario = scenarios.find((item) => item.id === scenarioId)!;
  const codebase = codebases.find((item) => item.id === target);
  const hit = codebase?.hits[scenarioId];
  const last = hit ? FINAL : TRACED;

  useEffect(() => {
    if (!target) return;
    if (reduced) {
      setStep(last);
      return;
    }
    setStep(1);
    const timer = window.setInterval(
      () => setStep((current) => (current >= last ? current : current + 1)),
      STEP_MS,
    );
    return () => window.clearInterval(timer);
  }, [target, run, last, reduced]);

  const start = (id: string) => {
    setTarget(id);
    setRun((count) => count + 1);
  };
  const choose = (id: ScenarioId) => {
    setScenarioId(id);
    setTarget(null);
    setStep(0);
  };

  const cardAt = (x: number, y: number) => {
    for (const [id, element] of cards.current) {
      const box = element.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return id;
    }
    return null;
  };
  const press = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) return;
    chip.current!.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.id) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < DRAG_START) return;
    state.moved = true;
    chip.current!.dataset.dragging = 'true';
    chip.current!.style.transform = `translate(${dx}px, ${dy}px)`;
    setHovered(cardAt(event.clientX, event.clientY));
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.id) return;
    drag.current = null;
    delete chip.current!.dataset.dragging;
    chip.current!.style.transform = '';
    setHovered(null);
    const over = state.moved ? cardAt(event.clientX, event.clientY) : null;
    if (over) start(over);
  };

  return (
    <section className="mock-play" aria-labelledby="play-title">
      <div className="mock-play-head" data-field-avoid>
        <h2 id="play-title">Drop Refit on a codebase.</h2>
        <p>
          Pick an API change, then drag the Refit mark onto a repository. A coding agent gets the
          same change, so you can compare what each one ships.
        </p>
      </div>

      <div className="mock-play-board" data-field-avoid>
        <div className="mock-play-changes" role="radiogroup" aria-label="API change">
          {scenarios.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={item.id === scenarioId}
              className="mock-play-change"
              onClick={() => choose(item.id)}
            >
              <img src={apiLogos[item.provider]} alt="" />
              <span>
                <strong>{item.change}</strong>
                <span>{item.version}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="mock-play-dock">
          <div
            ref={chip}
            className="mock-play-chip"
            aria-hidden="true"
            onPointerDown={press}
            onPointerMove={move}
            onPointerUp={release}
            onPointerCancel={release}
          >
            <Mark />
            <span>Refit</span>
          </div>
          <span className="mock-play-hint">Drag onto a repository</span>
        </div>

        <div className="mock-play-repos">
          {codebases.map((item) => (
            <RepositoryCard
              key={item.id}
              codebase={item}
              scenario={scenario}
              hovered={hovered === item.id}
              active={target === item.id}
              traced={target === item.id && step >= TRACED}
              register={(element) => {
                if (element) cards.current.set(item.id, element);
                else cards.current.delete(item.id);
              }}
              onRun={() => start(item.id)}
            />
          ))}
        </div>
      </div>

      <div className="mock-play-run" aria-live="polite" data-field-avoid>
        {codebase ? (
          <>
            <RefitLane scenario={scenario} codebase={codebase} step={step} />
            <AgentLane scenario={scenario} codebase={codebase} step={step} />
          </>
        ) : (
          <p className="mock-play-empty">
            Drop the mark on a repository to start a run. Nothing leaves your browser.
          </p>
        )}
      </div>
      <p className="mock-footnote" data-field-avoid>
        A simulation on illustrative repositories. The agent’s behaviour on the Stripe change
        matches Refit’s October 21 benchmark.
      </p>
    </section>
  );
}

function RepositoryCard({
  codebase,
  scenario,
  hovered,
  active,
  traced,
  register,
  onRun,
}: {
  codebase: Codebase;
  scenario: Scenario;
  hovered: boolean;
  active: boolean;
  traced: boolean;
  register: (element: HTMLElement | null) => void;
  onRun: () => void;
}) {
  const hit = codebase.hits[scenario.id];
  return (
    <article
      ref={register}
      className="mock-repo"
      data-hovered={hovered || undefined}
      data-active={active || undefined}
    >
      <header>
        <span className="mock-repo-mark">{active ? <Mark /> : null}</span>
        <strong>{codebase.name}</strong>
        <span>{codebase.stack}</span>
      </header>
      <ul>
        {codebase.files.map((file) => (
          <li key={file} data-hit={(traced && hit?.file === file) || undefined}>
            <FileTs size={14} />
            {file}
          </li>
        ))}
      </ul>
      <button type="button" className="mock-repo-run" onClick={onRun}>
        {active ? 'Run again' : 'Run Refit here'}
      </button>
    </article>
  );
}

function RefitLane({
  scenario,
  codebase,
  step,
}: {
  scenario: Scenario;
  codebase: Codebase;
  step: number;
}) {
  const hit = codebase.hits[scenario.id];
  return (
    <div className="mock-lane" data-lane="refit">
      <h3>
        <Mark /> Refit
      </h3>
      <ol>
        <LogLine done={step > 1} shown={step >= 1}>
          Read the {scenario.version} contract diff
        </LogLine>
        <LogLine done={step > TRACED || (!hit && step >= TRACED)} shown={step >= TRACED}>
          {hit
            ? `Traced ${hit.sites} call ${hit.sites === 1 ? 'site' : 'sites'} in ${hit.file}`
            : `No call sites in ${codebase.name}. Nothing to change.`}
        </LogLine>
      </ol>
      {hit && step >= PATCHED && (
        <Patch file={hit.file} scenario={scenario} added={scenario.added} />
      )}
      {hit && step > PATCHED && <Checks passed={step - PATCHED} />}
      {hit && step >= FINAL && (
        <div className="mock-lane-result" data-tone="positive">
          <GitPullRequest weight="bold" />
          <div>
            <strong>Draft pull request ready for review</strong>
            <span>Adapt to {scenario.change}</span>
          </div>
        </div>
      )}
      {!hit && step >= TRACED && (
        <div className="mock-lane-result" data-tone="neutral">
          <CheckCircle weight="bold" />
          <div>
            <strong>No pull request</strong>
            <span>Refit leaves unaffected repositories alone.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentLane({
  scenario,
  codebase,
  step,
}: {
  scenario: Scenario;
  codebase: Codebase;
  step: number;
}) {
  const hit = codebase.hits[scenario.id];
  const { agent } = scenario;
  return (
    <div className="mock-lane" data-lane="agent">
      <h3>
        <Robot /> A coding agent
      </h3>
      <ol>
        <LogLine done={step > 1} shown={step >= 1}>
          Read the changelog page
        </LogLine>
        <LogLine done={step > TRACED || (!hit && step >= TRACED)} shown={step >= TRACED}>
          {hit
            ? `Searched for ${scenario.field}`
            : `Searched ${codebase.files.length} files. Changed nothing.`}
        </LogLine>
      </ol>
      {hit && step >= PATCHED && <Patch file={hit.file} scenario={scenario} added={agent.added} />}
      {hit && step > PATCHED && <Checks passed={step - PATCHED} />}
      {hit && step >= FINAL && (
        <div className="mock-lane-result" data-tone={agent.correct ? 'positive' : 'negative'}>
          {agent.correct ? <CheckCircle weight="bold" /> : <Warning weight="bold" />}
          <div>
            <strong>{agent.correct ? 'Correct' : 'Checks pass. Behaviour changed.'}</strong>
            <span>{agent.verdict}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function LogLine({
  shown,
  done,
  children,
}: {
  shown: boolean;
  done: boolean;
  children: ReactNode;
}) {
  if (!shown) return null;
  return (
    <li data-done={done || undefined}>
      {done ? <CheckCircle weight="fill" /> : <CircleNotch className="mock-spin" />}
      {children}
    </li>
  );
}

function Patch({
  file,
  scenario,
  added,
}: {
  file: string;
  scenario: Scenario;
  added: string | null;
}) {
  return (
    <figure className="mock-patch">
      <figcaption>
        <FileTs size={14} /> {file}
      </figcaption>
      <pre>
        <code>
          <span>{scenario.context}</span>
          <span data-kind="removed">{scenario.removed}</span>
          {added && <span data-kind="added">{added}</span>}
        </code>
      </pre>
    </figure>
  );
}

function Checks({ passed }: { passed: number }) {
  return (
    <ul className="mock-checks">
      {CHECKS.map((check, index) => (
        <li key={check} data-done={index < passed || undefined}>
          {index < passed ? <CheckCircle weight="fill" /> : <CircleNotch className="mock-spin" />}
          {check}
        </li>
      ))}
    </ul>
  );
}
