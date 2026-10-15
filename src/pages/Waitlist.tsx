import { ArrowRight } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { scenarios, stages } from '../data';
import type { Scenario } from '../data';
import { Brand } from '../components/Brand';
import { Footer, Header } from '../components/Layout';
import { WaitlistForm } from '../components/WaitlistForm';
import { Workflow } from '../components/Workflow';

export function Waitlist() {
  const [scenario, setScenario] = useState<Scenario>('affected');
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="hero waitlist-hero" id="waitlist">
          <div className="hero-copy">
            <p className="waitlist-badge">
              <span /> Early access · Starting with Stripe
            </p>
            <h1>
              <span>APIs change.</span>
              <span>Your code keeps up.</span>
            </h1>
            <p>
              Refit turns upstream API changes into reviewed pull requests.
              <br className="desktop-break" /> It finds the affected code, prepares the fix and runs
              your checks before you review.
            </p>
            <WaitlistForm />
          </div>
        </section>
        <section className="waitlist-demo content-width" id="demo">
          <div className="section-heading">
            <h2>See a migration.</h2>
            <p>An illustrative walkthrough. Pick a scenario, then step through it.</p>
          </div>
          <div className="scenario-picker" aria-label="Example scenario">
            {(Object.keys(scenarios) as Scenario[]).map((key) => (
              <button
                key={key}
                className={scenario === key ? 'selected' : ''}
                aria-pressed={scenario === key}
                onClick={() => setScenario(key)}
              >
                {scenarios[key].label}
              </button>
            ))}
          </div>
          <p className="scenario-summary">{scenarios[scenario].summary}</p>
          <Workflow key={scenario} expanded scenario={scenario} />
          <Link className="text-link" to="/app">
            Explore the sample workspace <ArrowRight />
          </Link>
        </section>
        <section className="process-section content-width" id="how-it-works">
          <div className="section-heading">
            <h2>How it works.</h2>
            <p>The busywork between an API update and a safe migration.</p>
          </div>
          <div className="process-grid">
            {stages.map((stage, index) => (
              <article key={stage.id}>
                <span className="process-number">0{index + 1}</span>
                <h3>{stage.title}</h3>
                <p>{stage.description}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="closing-section">
          <div className="closing-rule" />
          <Brand />
          <h2>
            Be first in line
            <br />
            for the next API change.
          </h2>
          <a className="button button-primary" href="#waitlist">
            Join the waitlist <ArrowRight />
          </a>
          <p>Draft pull requests only. Refit never merges for you.</p>
        </section>
      </main>
      <Footer />
    </>
  );
}
