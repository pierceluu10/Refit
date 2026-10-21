import { ArrowRight } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { stages } from '../data';
import { AsciiBrackets } from '../components/AsciiBrackets';
import { Brand } from '../components/Brand';
import { Footer, Header } from '../components/Layout';
import { WaitlistForm } from '../components/WaitlistForm';
import { Workflow } from '../components/Workflow';

export function Waitlist() {
  return (
    <div className="waitlist-theme">
      <Header />
      <main id="main-content">
        <section className="hero" id="waitlist">
          <div className="hero-copy">
            <AsciiBrackets>
              <h1>
                <span>APIs change.</span>
                <span>Your code keeps up.</span>
              </h1>
            </AsciiBrackets>
            <p>
              Refit turns upstream API changes into reviewed pull requests.
              <br className="desktop-break" /> It finds the affected code, prepares the fix and runs
              your checks before you review.
            </p>
            <WaitlistForm />
          </div>
          <div className="hero-product" id="demo">
            <Workflow />
          </div>
        </section>
        <section className="process-section content-width" id="how-it-works">
          <div className="section-heading">
            <h2>
              From “what changed?”
              <br />
              to “ready to review.”
            </h2>
            <p>The busywork between an API update and a safe migration.</p>
          </div>
          <div className="process-grid">
            {stages.map((stage, index) => (
              <article key={stage.id}>
                <span className="process-number">0{index + 1}</span>
                <h3>{stage.title}</h3>
                <p>{stage.description}</p>
                <div className="process-artifact">
                  <span />
                  {stage.artifact}
                </div>
              </article>
            ))}
          </div>
          <Link className="text-link" to="/demo">
            Walk through every scenario <ArrowRight />
          </Link>
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
          <p>Early access starts with Stripe. Refit never merges for you.</p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
