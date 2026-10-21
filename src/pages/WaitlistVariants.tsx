import { ArrowUpRight } from '@phosphor-icons/react';
import { AgentDemo } from '../components/AgentDemo';
import { AsciiWordmark } from '../components/AsciiWordmark';
import { Header } from '../components/Layout';
import { Progression } from '../components/Progression';
import { WaitlistForm } from '../components/WaitlistForm';
import { PROJECT_URL } from '../data';
import './variants.css';

// Three waitlist directions under review at /v1, /v2 and /v3. Each pairs the ASCII logo, the
// Refit Agent demo and the stage progression differently.

const summary =
  'Refit watches the APIs you depend on, finds the code a change breaks, and opens a draft pull request for your review.';

function VariantFooter() {
  return (
    <footer className="variant-footer">
      <span>© {new Date().getFullYear()} Refit</span>
      <span>Human reviewed. Never auto-merged.</span>
      <a href={PROJECT_URL} target="_blank" rel="noreferrer">
        GitHub <ArrowUpRight size={12} />
      </a>
    </footer>
  );
}

// Context.dev-like: a centered ASCII logo, the signup, then the demo in a blue dotted frame.
export function WaitlistBlueprint() {
  return (
    <div className="waitlist-theme variant variant-blueprint">
      <Header minimal />
      <main id="main-content">
        <section className="blueprint-hero" id="waitlist">
          <AsciiWordmark columns={150} className="blueprint-logo" />
          <h1>
            <span>APIs change.</span> <span>Your code keeps up.</span>
          </h1>
          <p>{summary}</p>
          <WaitlistForm />
        </section>
        <section className="blueprint-demo" aria-label="Demo">
          <div className="blueprint-frame">
            <AgentDemo />
          </div>
        </section>
        <section className="variant-steps" aria-labelledby="blueprint-steps">
          <h2 id="blueprint-steps">From changelog to pull request.</h2>
          <Progression layout="ladder" />
        </section>
        <section className="variant-close" aria-labelledby="blueprint-close">
          <AsciiWordmark columns={30} word={false} />
          <h2 id="blueprint-close">Be ready for the next breaking change.</h2>
          <WaitlistForm />
        </section>
      </main>
      <VariantFooter />
    </div>
  );
}

// Prized-like: a full-bleed blue hero with the dark demo beside the copy and the ASCII logo
// spanning its base.
export function WaitlistCobalt() {
  return (
    <div className="waitlist-theme variant variant-cobalt">
      <div className="cobalt-band">
        <Header minimal />
        <main id="main-content">
          <section className="cobalt-hero" id="waitlist">
            <div className="cobalt-copy">
              <h1>
                <span>The API changed.</span> <span>Your PR is ready.</span>
              </h1>
              <p>{summary}</p>
              <WaitlistForm />
            </div>
            <AgentDemo tone="dark" />
          </section>
        </main>
        <AsciiWordmark columns={150} className="cobalt-logo" />
      </div>
      <section className="variant-steps cobalt-steps" aria-labelledby="cobalt-steps">
        <h2 id="cobalt-steps">Four stages. You approve the last one.</h2>
        <Progression layout="track" />
      </section>
      <section className="variant-close" aria-labelledby="cobalt-close">
        <h2 id="cobalt-close">Stop finding out from production.</h2>
        <WaitlistForm />
      </section>
      <VariantFooter />
    </div>
  );
}

// Agnost-like: a split hero with the ASCII mark over the copy, a framed demo, a sticky rail of
// stages and a giant wordmark bleeding off the foot of the page.
export function WaitlistSplit() {
  return (
    <div className="waitlist-theme variant variant-split">
      <Header minimal />
      <main id="main-content">
        <section className="split-hero" id="waitlist">
          <div className="split-copy">
            <AsciiWordmark columns={44} word={false} className="split-mark" />
            <h1>Stop chasing API changelogs.</h1>
            <p>{summary}</p>
            <WaitlistForm />
          </div>
          <div className="split-demo">
            <AgentDemo />
          </div>
        </section>
        <section className="split-steps" aria-labelledby="split-steps">
          <div className="split-steps-heading">
            <h2 id="split-steps">What Refit Agent does when an API moves.</h2>
            <p>Breaking changes first. Anything ambiguous stops for a person.</p>
          </div>
          <Progression layout="rail" />
        </section>
      </main>
      <div className="split-foot">
        <VariantFooter />
        <AsciiWordmark columns={140} className="split-logo" />
      </div>
    </div>
  );
}
