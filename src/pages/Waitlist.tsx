import { ArrowDown } from '@phosphor-icons/react';
import { AsciiBrackets } from '../components/AsciiBrackets';
import { Header } from '../components/Layout';
import { LogoBelt } from '../components/LogoBelt';
import { ScrollStage } from '../components/ScrollStage';
import { WaitlistForm } from '../components/WaitlistForm';
import { Workflow } from '../components/Workflow';
import { WorkflowMap } from '../components/WorkflowMap';

// The waitlist page is one screen: the hero with the signup and the pipeline map. A scroll plays
// the labelled demo up over it instead of moving the page down.
export function Waitlist() {
  return (
    <div className="waitlist-theme">
      <ScrollStage
        hero={
          <>
            <Header minimal />
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
                    <br className="desktop-break" /> It finds the affected code, prepares the fix
                    and runs your checks before you review.
                  </p>
                  <WaitlistForm />
                  <LogoBelt />
                </div>
                <div className="hero-product">
                  <WorkflowMap />
                </div>
              </section>
            </main>
          </>
        }
        cue={
          <a href="#demo">
            Scroll to see the demo <ArrowDown />
          </a>
        }
        preview={
          <section id="demo" aria-labelledby="demo-title">
            <div className="demo-label">
              <span className="demo-badge">Demo</span>
              <h2 id="demo-title">See how Refit handles one API change</h2>
              <p>Illustrative example. Click any stage.</p>
            </div>
            <Workflow map={false} />
          </section>
        }
      />
    </div>
  );
}
