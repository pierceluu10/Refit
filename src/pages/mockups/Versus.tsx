import { ArrowUpRight } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BENCHMARK_URL, comparison } from './data';
import { DotGlobe } from './DotGlobe';

// Refit against a coding agent, after Latent's comparison: a question and its answer, two race
// cards whose bars run out when they scroll into view, and a tinted band for teams that keep
// their agent.
export function VersusSection() {
  return (
    <section className="mock-versus" aria-labelledby="versus-title">
      <DotGlobe className="mock-versus-globe" />
      <div className="mock-versus-head" data-field-avoid>
        <h2 id="versus-title">Why not ask a coding agent to do it?</h2>
        <p>
          You can. It reads the changelog, edits what it finds and gets your tests to pass. Then a
          checkout quietly accepts different cards. Refit reads the provider’s contract first, so it
          knows which edits change behaviour and stops on those.
        </p>
      </div>
      <div className="mock-versus-cards" data-field-avoid>
        <RaceCard {...comparison.correct} />
        <RaceCard {...comparison.cost} />
      </div>
      <div className="mock-versus-band" data-field-avoid>
        <div>
          <h3>Keeping your agent?</h3>
          <p>
            Refit hands it the brief it was missing: the contract diff, every call site and the
            rules it must not break.
          </p>
        </div>
        {comparison.stats.map((stat) => (
          <div key={stat.label} className="mock-versus-stat">
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
            <span>{stat.detail}</span>
          </div>
        ))}
      </div>
      <p className="mock-footnote" data-field-avoid>
        Agent figures are from Refit’s October 21 benchmark of OpenAI’s Codex CLI.{' '}
        <a href={BENCHMARK_URL} target="_blank" rel="noreferrer">
          Read the method <ArrowUpRight size={12} />
        </a>{' '}
        Refit figures are launch targets.
      </p>
    </section>
  );
}

function RaceCard({
  title,
  headline,
  rows,
  note,
}: {
  title: string;
  headline: string;
  rows: { label: string; value: number; display: string }[];
  note: string;
}) {
  const card = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setShown(true);
        observer.disconnect();
      },
      { threshold: 0.35 },
    );
    observer.observe(card.current!);
    return () => observer.disconnect();
  }, []);

  return (
    <article ref={card} className="mock-race" data-shown={shown || undefined}>
      <h3>{title}</h3>
      <strong className="mock-race-headline">{headline}</strong>
      <dl>
        {rows.map((row) => (
          <div
            key={row.label}
            className="mock-race-row"
            data-refit={row.label === 'Refit' || undefined}
          >
            <dt>{row.label}</dt>
            <dd>
              <span className="mock-race-track">
                <span style={{ '--value': row.value / 100 } as CSSProperties} />
              </span>
              <span className="mock-race-value">{row.display}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p>{note}</p>
    </article>
  );
}
