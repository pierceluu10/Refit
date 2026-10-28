import { AgentDemo } from '../../components/AgentDemo';
import { AsciiWordmark } from '../../components/AsciiWordmark';
import { WaitlistForm } from '../../components/WaitlistForm';
import { DotHorizon } from './DotHorizon';

const SUBLINE =
  'When an API changes, Refit finds what breaks and drafts the fix as a pull request.';

// The copy centred over a plane of dots; the demo lies tilted on the plane and stands up as the
// page scrolls, so the first screen shows its top edge rising over the horizon.
export function HorizonHero() {
  return (
    <section className="mock-horizon" id="waitlist">
      <div className="mock-horizon-copy" data-field-avoid>
        <AsciiWordmark columns={44} word={false} className="mock-horizon-mark" />
        <h1>Stop chasing API changelogs.</h1>
        <p>{SUBLINE}</p>
        <WaitlistForm />
      </div>
      <div className="mock-horizon-stage" data-field-avoid>
        <DotHorizon className="mock-horizon-plane" />
        <div className="mock-horizon-tilt">
          <div className="launch-frame">
            <AgentDemo />
          </div>
        </div>
      </div>
    </section>
  );
}

// The headline is itself a diff: the old chore is struck out and the new line is written in, in
// the same red and green as the demo beside it.
export function DiffHero() {
  return (
    <section className="launch-hero mock-diff" id="waitlist">
      <div className="launch-copy">
        <div data-field-avoid>
          <AsciiWordmark columns={44} word={false} className="launch-mark" />
        </div>
        <h1 className="mock-diff-title" data-field-avoid>
          <span className="sr-only">Stop reading every API changelog. Let Refit read them.</span>
          <span className="mock-diff-line" data-kind="removed" aria-hidden="true">
            <span className="mock-diff-sign">−</span>
            <span className="mock-diff-text">Read every API changelog.</span>
          </span>
          <span className="mock-diff-line" data-kind="added" aria-hidden="true">
            <span className="mock-diff-sign">+</span>
            <span className="mock-diff-text">Let Refit read them.</span>
          </span>
        </h1>
        <p data-field-avoid>{SUBLINE}</p>
        <div data-field-avoid>
          <WaitlistForm />
        </div>
      </div>
      <div className="launch-demo" data-field-avoid>
        <div className="launch-frame">
          <AgentDemo />
        </div>
      </div>
    </section>
  );
}
