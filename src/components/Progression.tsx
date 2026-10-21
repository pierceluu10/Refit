import { stages } from '../data';

// One line of real artifact per stage, from the same illustrative Stripe change as the demo.
const evidence: Record<(typeof stages)[number]['id'], string[]> = {
  detect: ['PaymentIntent', '− charges', '+ latest_charge'],
  understand: ['payments.ts:9', 'charges.data[0]'],
  validate: ['✓ typecheck', '✓ lint', '✓ test'],
  review: ['Draft pull request', 'Waiting for your review'],
};

// The four stages on a dashed rail that fills as the page scrolls past it. `layout` picks the
// shape: a zigzag ladder, a horizontal track, or a rail down the left edge. Browsers without
// scroll-driven animations, and reduced motion, show the rail already filled.
export function Progression({ layout }: { layout: 'ladder' | 'track' | 'rail' }) {
  return (
    <div className={`progression progression-${layout}`}>
      <span className="progression-line" aria-hidden="true">
        <span />
      </span>
      <ol>
        {stages.map((stage, index) => (
          <li key={stage.id} className="progression-step">
            <span className="progression-marker" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <div className="progression-card">
              <span className="progression-tag">{stage.short}</span>
              <h3>{stage.title}</h3>
              <p>{stage.description}</p>
              <pre className="progression-evidence">{evidence[stage.id].join('\n')}</pre>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
