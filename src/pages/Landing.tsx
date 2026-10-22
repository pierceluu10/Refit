import {
  ArrowRight,
  ArrowUpRight,
  BracketsCurly,
  Check,
  Code,
  GithubLogo,
  GitPullRequest,
  ShieldCheck,
} from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { configuration, PROJECT_URL, stages } from '../data';
import { Brand, Mark } from '../components/Brand';
import { CopyButton } from '../components/CopyButton';
import { Footer, Header } from '../components/Layout';
import { Workflow } from '../components/Workflow';

const questions = [
  {
    question: 'What does Refit actually change?',
    answer:
      'Refit is designed to update the application code affected by an external API change—not just bump a dependency version. It traces the change to relevant source files, generates a focused patch, and requires your project’s checks to pass before opening a draft PR.',
  },
  {
    question: 'Which APIs and languages are supported?',
    answer:
      'The first planned integration is Stripe, for TypeScript and JavaScript repositories on GitHub. The provider architecture is designed to expand later. This frontend previews that workflow; live monitoring is still in development.',
  },
  {
    question: 'Will Refit merge changes automatically?',
    answer:
      'No. Every successful migration is intended to produce a draft pull request. Your team reviews the evidence and decides whether and when to merge.',
  },
  {
    question: 'What happens when tests fail?',
    answer:
      'The planned pipeline gives the agent a bounded number of repair attempts. If required checks still fail, no pull request is published. The run retains the failure evidence for inspection.',
  },
  {
    question: 'Can I connect my repository today?',
    answer:
      'Not yet. This release is an interactive frontend preview. You can explore sample migrations, browse the sample workspace, and read the implementation specification. It does not request GitHub permissions or access your code.',
  },
];

export function Landing() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="hero">
          <div className="hero-copy">
            <h1>
              <span>APIs change.</span>
              <span>Your code keeps up.</span>
            </h1>
            <p>
              Turn upstream API changes into reviewed code.
              <br className="desktop-break" /> Refit finds the impact, prepares the patch, and puts
              you in control.
            </p>
            <div className="hero-actions">
              <Link className="button button-primary" to="/demo">
                See a migration <ArrowRight />
              </Link>
              <a
                className="button button-secondary"
                href={PROJECT_URL}
                target="_blank"
                rel="noreferrer"
              >
                <GithubLogo weight="bold" /> View on GitHub
              </a>
            </div>
          </div>
          <div className="hero-product">
            <Workflow />
          </div>
        </section>
        <div className="scope-strip">
          <span>Starting with the stack you ship.</span>
          <div>
            <span>
              <span className="stripe-wordmark">stripe</span>
            </span>
            <span>
              <span className="typescript-icon">TS</span> TypeScript
            </span>
            <span>
              <GithubLogo weight="fill" size={23} /> GitHub
            </span>
          </div>
          <Link to="/docs#scope">
            See the scope <ArrowUpRight size={14} />
          </Link>
        </div>
        <section className="process-section content-width" id="how-it-works">
          <div className="section-heading">
            <h2>
              From “what changed?”
              <br />
              to “ready to review.”
            </h2>
            <p>
              The busywork between an API update and a safe migration.
              <br className="desktop-break" /> That’s where Refit comes in.
            </p>
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
            Walk through an example <ArrowRight />
          </Link>
        </section>
        <section className="control-section">
          <div className="control-inner content-width">
            <div className="control-copy">
              <div className="control-mark">
                <Mark />
              </div>
              <h2>
                Autonomous work.
                <br />
                Human control.
              </h2>
              <p>
                A migration should earn your trust.
                <br />
                Refit is designed to show its work.
              </p>
              <ul>
                <li>
                  <ShieldCheck />
                  <div>
                    <strong>Isolated by default</strong>
                    <span>Changes happen in a sandbox, away from production.</span>
                  </div>
                </li>
                <li>
                  <Code />
                  <div>
                    <strong>Your repo. Your rules.</strong>
                    <span>Run the checks your team already relies on.</span>
                  </div>
                </li>
                <li>
                  <GitPullRequest />
                  <div>
                    <strong>Always a draft</strong>
                    <span>You get the final say. No automatic merges.</span>
                  </div>
                </li>
              </ul>
              <Link to="/docs#review" className="text-link">
                Read about the review boundary <ArrowRight />
              </Link>
            </div>
            <div className="configuration-panel">
              <div className="configuration-title">
                <span>
                  <BracketsCurly /> refit.yml
                </span>
                <CopyButton text={configuration} />
              </div>
              <pre>
                <code>
                  <span className="code-comment">
                    # Fits your workflow. Not the other way around.
                  </span>
                  {'\n\n'}
                  {configuration.split('\n').map((line, index) => (
                    <span className="config-line" key={index}>
                      {line.includes(':') ? (
                        <>
                          <span className="config-key">{line.split(':')[0]}:</span>
                          {line.slice(line.indexOf(':') + 1)}
                        </>
                      ) : (
                        line
                      )}
                      {'\n'}
                    </span>
                  ))}
                </code>
              </pre>
              <div className="config-bottom">
                <Check /> Versioned with your code.
              </div>
            </div>
          </div>
        </section>
        <section className="review-section content-width">
          <div className="review-statement">
            <span className="review-symbol">
              <GitPullRequest weight="light" />
            </span>
            <h2>
              The best update
              <br />
              is one you understand.
            </h2>
            <p>
              Know why a change matters before it lands.
              <br />
              The provider’s context, your affected code, and the path to a fix—together.
            </p>
            <Link to="/sample" className="button button-secondary">
              Explore the workspace <ArrowRight />
            </Link>
          </div>
          <div className="evidence-sheet">
            <div className="sheet-title">
              <span className="sheet-avatar">
                <Mark />
              </span>
              <div>
                <strong>Refit</strong>
                <span>Migration summary · illustrative example</span>
              </div>
              <span className="draft-badge">Draft</span>
            </div>
            <h3>Adapt payment charge lookup</h3>
            <p>
              The PaymentIntent response now uses a latest-charge reference. This example updates
              the billing wrapper to handle its ID or expanded object.
            </p>
            <div className="sheet-file">
              <Code size={16} />
              <code>src/billing/payments.ts</code>
              <span>+3 −1</span>
            </div>
            <div className="sheet-evidence">
              <div>
                <CheckCircleIcon />
                <span>Provider change explained</span>
              </div>
              <div>
                <CheckCircleIcon />
                <span>Affected code identified</span>
              </div>
              <div>
                <CheckCircleIcon />
                <span>Review stays with your team</span>
              </div>
            </div>
            <span className="sheet-footnote">
              A preview of the review experience. No live PR created.
            </span>
          </div>
        </section>
        <section className="faq-section content-width">
          <div>
            <h2>A few good questions.</h2>
            <p>Clear answers, before you connect.</p>
            <Link className="text-link" to="/docs">
              Go a little deeper <ArrowUpRight />
            </Link>
          </div>
          <div className="faq-list">
            {questions.map((item) => (
              <details key={item.question}>
                <summary>
                  {item.question}
                  <span className="faq-plus" aria-hidden="true" />
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="closing-section">
          <div className="closing-rule" />
          <Brand />
          <h2>
            Keep building.
            <br />
            Let your integrations keep up.
          </h2>
          <Link className="button button-primary" to="/demo">
            Explore the interactive demo <ArrowRight />
          </Link>
          <p>See what’s taking shape. No account required.</p>
        </section>
      </main>
      <Footer />
    </>
  );
}

function CheckCircleIcon() {
  return (
    <span className="sheet-check">
      <Check size={12} weight="bold" />
    </span>
  );
}
