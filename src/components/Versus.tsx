import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { DotGlobe } from './DotGlobe';

// The coding agent's figures are from the October 21 comparison in main's docs/BENCHMARKS.md:
// 1 of 8 patches that passed validation was correct, and 17 runs cost $6.45. Refit's are the
// owner's launch targets, not measurements; replace them before this ships.
const comparison = {
  correct: {
    title: 'Patches that were right after review',
    headline: '7.9× more often',
    rows: [
      { label: 'A coding agent', value: 12.5, display: '12.5%' },
      { label: 'Refit', value: 98.4, display: '98.4%' },
    ],
  },
  cost: {
    title: 'AI spend per repository',
    headline: '2,900× cheaper',
    rows: [
      { label: 'A coding agent', value: 100, display: '$0.38' },
      { label: 'Refit', value: 0.4, display: '$0.00013' },
    ],
  },
  stats: [
    { value: '0', label: 'silent behaviour changes', detail: 'against 7 of 8 agent patches' },
    { value: '381 / 381', label: 'repeat runs identical', detail: 'same input, same pull request' },
  ],
};

// Refit against a coding agent, after Latent's comparison: a question and its answer, two race
// cards whose bars run out when they scroll into view, and a tinted band for teams that keep
// their agent.
export function VersusSection() {
  return (
    <section className="launch-versus" aria-labelledby="versus-title">
      <DotGlobe className="launch-versus-globe" />
      <div className="launch-versus-head" data-field-avoid>
        <h2 id="versus-title">Why not ask a coding agent to do it?</h2>
        <p>
          You can. It reads the changelog, edits what it finds and gets your tests to pass. Then a
          checkout quietly accepts different cards. Refit reads the provider’s contract first, so it
          knows which edits change behaviour and stops on those.
        </p>
      </div>
      <div className="launch-versus-cards" data-field-avoid>
        <RaceCard {...comparison.correct} />
        <RaceCard {...comparison.cost} />
      </div>
      <div className="launch-versus-band" data-field-avoid>
        <div>
          <h3>Keeping your agent?</h3>
          <p>
            Refit hands it the brief it was missing: the contract diff, every call site and the
            rules it must not break.
          </p>
        </div>
        {comparison.stats.map((stat) => (
          <div key={stat.label} className="launch-versus-stat">
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
            <span>{stat.detail}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function RaceCard({
  title,
  headline,
  rows,
}: {
  title: string;
  headline: string;
  rows: { label: string; value: number; display: string }[];
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
    <article ref={card} className="launch-race" data-shown={shown || undefined}>
      <h3>{title}</h3>
      <strong className="launch-race-headline">{headline}</strong>
      <dl>
        {rows.map((row) => (
          <div
            key={row.label}
            className="launch-race-row"
            data-refit={row.label === 'Refit' || undefined}
          >
            <dt>{row.label}</dt>
            <dd>
              <span className="launch-race-track">
                <span style={{ '--value': row.value / 100 } as CSSProperties} />
              </span>
              <span className="launch-race-value">{row.display}</span>
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
