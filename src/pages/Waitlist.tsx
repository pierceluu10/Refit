import { AgentDemo } from '../components/AgentDemo';
import { AsciiWordmark } from '../components/AsciiWordmark';
import { Header } from '../components/Layout';
import { ParticleField } from '../components/ParticleField';
import { Progression } from '../components/Progression';
import { WaitlistForm } from '../components/WaitlistForm';
import './waitlist.css';

// The waitlist page: a split hero with the signup beside the Refit Agent demo on a drafting
// sheet, the stages on a rail, and a blue band with the glinting ASCII logo to close.
export function Waitlist() {
  return (
    <div className="waitlist-theme launch">
      <ParticleField />
      <div className="launch-top">
        <Header minimal />
        <main id="main-content">
          <section className="launch-hero" id="waitlist">
            <div className="launch-copy">
              <div data-field-avoid>
                <AsciiWordmark columns={44} word={false} className="launch-mark" />
              </div>
              <h1 data-field-avoid>Stop chasing API changelogs.</h1>
              <p data-field-avoid>
                When an API changes, Refit finds what breaks and drafts the fix as a pull request.
              </p>
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
        </main>
      </div>
      <section className="launch-steps" aria-labelledby="steps-title">
        <div className="launch-steps-heading" data-field-avoid>
          <h2 id="steps-title">What Refit Agent does when an API moves.</h2>
          <p>Breaking changes first. Anything ambiguous stops for a person.</p>
        </div>
        <Progression />
      </section>
      <section className="launch-close" aria-labelledby="close-title">
        <h2 id="close-title">Be ready for the next breaking change.</h2>
        <WaitlistForm />
        <AsciiWordmark columns={150} glint className="launch-logo" />
      </section>
    </div>
  );
}
