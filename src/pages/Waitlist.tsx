import { AgentDemo } from '../components/AgentDemo';
import { AsciiWordmark } from '../components/AsciiWordmark';
import { Header } from '../components/Layout';
import { ParticleField } from '../components/ParticleField';
import { StackSection } from '../components/Stack';
import { VersusSection } from '../components/Versus';
import { WaitlistForm } from '../components/WaitlistForm';
import './waitlist.css';

// The waitlist page: the signup over a plane of dots with the Refit Agent demo standing up from
// it, Refit against a coding agent, the stages as a 3D stack, and a blue band with the glinting
// ASCII logo to close.
export function Waitlist() {
  return (
    <div className="waitlist-theme launch">
      <ParticleField />
      <div className="launch-top">
        <Header minimal />
        <main id="main-content">
          <LaunchHero />
        </main>
      </div>
      <VersusSection />
      <StackSection />
      <LaunchClose />
    </div>
  );
}

// The demo lies tilted back and stands up as the page scrolls, so the first screen shows its
// top edge rising into view.
function LaunchHero() {
  return (
    <section className="launch-horizon" id="waitlist">
      <div className="launch-horizon-copy" data-field-avoid>
        <AsciiWordmark columns={44} word={false} className="launch-horizon-mark" />
        <h1>Stop chasing API changelogs.</h1>
        <p>When an API changes, Refit finds what breaks and drafts the fix as a pull request.</p>
        <WaitlistForm />
      </div>
      <div className="launch-horizon-stage" data-field-avoid>
        <div className="launch-horizon-tilt">
          <div className="launch-frame">
            <AgentDemo />
          </div>
        </div>
      </div>
    </section>
  );
}

function LaunchClose() {
  return (
    <section className="launch-close" aria-labelledby="close-title">
      <h2 id="close-title">Be ready for the next breaking change.</h2>
      <WaitlistForm />
      <AsciiWordmark columns={150} glint className="launch-logo" />
    </section>
  );
}
