import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Code,
  GithubLogo,
  GitPullRequest,
  ShieldCheck,
} from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { PROJECT_URL, stages } from '../data';
import { Brand, Mark } from '../components/Brand';
import { Footer, Header } from '../components/Layout';
import { Workflow } from '../components/Workflow';

const questions = [
  {
    question: 'What does Refit actually change?',
    answer:
      'The application code an API change affects, not just a dependency version. It edits the affected call sites in a sandbox, runs your checks before and after, and opens a pull request with the proof.',
  },
  {
    question: 'Which APIs does it cover?',
    answer:
      'The agent records any external API it finds in your code: SDKs, raw HTTP, GraphQL and webhooks. The first provider watchers are planned for Stripe, Shopify, Meta Graph, OpenAI and Twilio. None of this is live yet.',
  },
  {
    question: 'Will Refit merge changes automatically?',
    answer:
      'No. Refit only opens pull requests. It never merges and never pushes to your default branch. Your team reviews the proof and decides.',
  },
  {
    question: 'What happens when tests fail?',
    answer:
      'The agent keeps iterating and counts only the failures its change introduced. If it can’t make the checks pass, it still opens the pull request, marks it needs-review and says exactly what is unproven.',
  },
  {
    question: 'Does it get better over time?',
    answer:
      'That is the plan. Every run is recorded, including whether your team merged, closed or edited the pull request. Approaches that worked become recipes for future runs.',
  },
  {
    question: 'Can I connect my repository today?',
    answer:
      'Not yet. Refit is in development and has no GitHub connection. You can explore sample migrations and the sample dashboard. Nothing here requests GitHub permissions or reads your code.',
  },
];

const watchedProviders = ['Stripe', 'Shopify', 'Meta Graph', 'OpenAI', 'Twilio'];

const pullRequestNote = `outcome: needs-review
changed: src/billing/payments.ts (+3 −1)
why: charges → latest_charge
typecheck: pass before, pass after
build: pass before, pass after
tests: 1 new failure
unproven: refunds with an expanded charge`;

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
              Refit learns every API your code uses and watches them for changes.
              <br className="desktop-break" /> When one affects you, it migrates the code, proves
              it, and opens a pull request.
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
          <span>First provider watchers. The agent maps any API it finds.</span>
          <div>
            {watchedProviders.map((provider) => (
              <span key={provider}>{provider}</span>
            ))}
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
                    <span>Your code runs only in a sandbox, away from production.</span>
                  </div>
                </li>
                <li>
                  <Code />
                  <div>
                    <strong>Proof, not promises</strong>
                    <span>Your checks run before and after. Only new failures count.</span>
                  </div>
                </li>
                <li>
                  <GitPullRequest />
                  <div>
                    <strong>Pull requests only</strong>
                    <span>It never merges and never pushes to your default branch.</span>
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
                  <GitPullRequest /> pull request note
                </span>
                <span className="configuration-label">Illustrative</span>
              </div>
              <pre>
                <code>
                  <span className="code-comment"># What every Refit PR tells you.</span>
                  {'\n\n'}
                  {pullRequestNote.split('\n').map((line, index) => (
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
                <Check /> Unsure? It tries anyway and says so.
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
              The provider’s note, your affected code and the proof, together.
            </p>
            <Link to="/app" className="button button-secondary">
              Explore the dashboard <ArrowRight />
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
              <span className="draft-badge">Verified</span>
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
                <span>Affected call sites identified</span>
              </div>
              <div>
                <CheckCircleIcon />
                <span>Checks compared before and after</span>
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
