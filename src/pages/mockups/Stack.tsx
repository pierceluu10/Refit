import { Robot } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Mark } from '../../components/Brand';
import { evidence } from '../../components/Progression';
import { stages } from '../../data';

// What a coding agent does at the same stage, for the one-line contrast under each step.
const agentAt: Record<(typeof stages)[number]['id'], string> = {
  detect: 'Reads the changelog prose and guesses what moved.',
  understand: 'Greps for the field name, wrappers and all.',
  validate: 'Edits until the tests it found are green.',
  review: 'Keeps going, even when the change is a judgement call.',
};

// The pipeline as a stack of glass layers seen from above. The stack stays pinned while the
// stages scroll past it, and the layer for the stage at the middle of the screen lifts out of
// the stack and lights up.
export function StackSection() {
  const [active, setActive] = useState(0);
  const steps = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) setActive(steps.current.indexOf(entry.target as HTMLElement));
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    steps.current.forEach((step) => observer.observe(step!));
    return () => observer.disconnect();
  }, []);

  return (
    <section className="mock-stack" aria-labelledby="stack-title">
      <div className="mock-stack-visual" aria-hidden="true">
        <div className="mock-stack-scene">
          {stages.map((stage, index) => (
            <div
              key={stage.id}
              className="mock-layer"
              style={{ '--index': index } as CSSProperties}
              data-state={index === active ? 'active' : index < active ? 'done' : undefined}
            >
              <span className="mock-layer-name">{stage.short}</span>
              <pre>{evidence[stage.id].join('\n')}</pre>
            </div>
          ))}
        </div>
      </div>
      <div className="mock-stack-steps">
        <div className="mock-stack-head" data-field-avoid>
          <h2 id="stack-title">Four layers between an API change and your merge.</h2>
          <p>Each one leaves evidence you can read. A coding agent skips most of them.</p>
        </div>
        {stages.map((stage, index) => (
          <article
            key={stage.id}
            ref={(element) => {
              steps.current[index] = element;
            }}
            className="mock-stack-step"
            data-active={index === active || undefined}
            data-field-avoid
          >
            <h3>{stage.title}</h3>
            <p>{stage.description}</p>
            <dl>
              <div>
                <dt>
                  <Mark /> Refit
                </dt>
                <dd>{stage.detail}</dd>
              </div>
              <div>
                <dt>
                  <Robot /> A coding agent
                </dt>
                <dd>{agentAt[stage.id]}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
