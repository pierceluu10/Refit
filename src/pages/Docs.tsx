import { ArrowRight, ArrowUpRight, BookOpen, Info } from '@phosphor-icons/react';
import { Link, useLocation } from 'react-router-dom';
import { CopyButton } from '../components/CopyButton';
import { Header, Footer } from '../components/Layout';
import { PROJECT_URL } from '../data';

const configuration = 'pause: false\n';
import './docs.css';

const topics = [
  { id: 'introduction', title: 'Introduction' },
  { id: 'scope', title: 'Supported scope' },
  { id: 'installation', title: 'GitHub installation' },
  { id: 'configuration', title: 'Repository configuration' },
  { id: 'review', title: 'Review & validation' },
  { id: 'replay', title: 'Replay & recovery' },
];

export function Docs() {
  const { hash } = useLocation();
  return (
    <>
      <Header />
      <div className="docs-layout content-width">
        <aside className="docs-sidebar">
          <span>
            <BookOpen /> Documentation
          </span>
          <nav aria-label="Documentation topics">
            {topics.map((topic) => (
              <a
                key={topic.id}
                href={`#${topic.id}`}
                className={(hash || '#introduction') === `#${topic.id}` ? 'selected' : ''}
              >
                {topic.title}
              </a>
            ))}
          </nav>
          <a
            className="docs-source"
            href={`${PROJECT_URL}/blob/main/docs/PRD.md`}
            target="_blank"
            rel="noreferrer"
          >
            Full product specification <ArrowUpRight size={13} />
          </a>
        </aside>
        <main id="main-content" className="docs-content">
          <section id="introduction">
            <h1>Meet Refit.</h1>
            <p className="docs-lead">
              An agent for the work between an API changing and your code catching up.
            </p>
            <div className="demo-notice">
              <Info size={18} />
              <span>
                <strong>Frontend preview.</strong> The migration pipeline is specified, but not
                implemented in this release. The demo and workspace contain labeled sample data.
              </span>
            </div>
            <p>
              Refit is designed to watch authoritative API specifications, find affected usage in
              your repository, and prepare a validated draft pull request. You keep the final review
              and merge decision.
            </p>
            <p>
              Use the interactive walkthrough to explore the intended experience without signing in
              or sharing a repository.
            </p>
            <Link className="button button-primary" to="/demo">
              Explore the workflow <ArrowRight />
            </Link>
          </section>
          <section id="scope">
            <h2>Start focused. Prove the loop.</h2>
            <p>
              The first migration path targets a deliberately narrow stack. Other providers and
              languages are future work.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Initial target</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>API provider</td>
                  <td>Stripe</td>
                </tr>
                <tr>
                  <td>Source of changes</td>
                  <td>Versioned Stripe OpenAPI specifications</td>
                </tr>
                <tr>
                  <td>Repository language</td>
                  <td>TypeScript and JavaScript</td>
                </tr>
                <tr>
                  <td>Source control</td>
                  <td>GitHub</td>
                </tr>
                <tr>
                  <td>Result</td>
                  <td>A validated draft pull request</td>
                </tr>
              </tbody>
            </table>
            <p>
              The preview illustrates a PaymentIntent field migration. Its sample code is
              explanatory, not a universal Stripe upgrade recipe. A production migration must use
              the repository’s exact API and SDK versions.
            </p>
          </section>
          <section id="installation">
            <h2>Connect only what you choose.</h2>
            <p>
              GitHub installation is not available in this preview. The planned flow uses a GitHub
              App so you can select repositories rather than hand over a personal access token.
            </p>
            <ol>
              <li>Review the app’s requested permissions in GitHub.</li>
              <li>Select the repositories Refit may access.</li>
              <li>Let the initial scan identify supported provider usage.</li>
              <li>Confirm monitoring after initialization succeeds.</li>
            </ol>
            <p>
              The planned permissions cover repository metadata, code access, generated migration
              branches, and pull requests. The final permission list must be reviewed against the
              implemented GitHub App before launch. Refit must not request customer production API
              keys.
            </p>
            <div className="docs-callout">
              <strong>Nothing is connected in this release.</strong>
              <p>
                The sample workspace runs in your browser and does not read your GitHub account or
                repositories.
              </p>
            </div>
          </section>
          <section id="configuration">
            <h2>Your checks, in your repository.</h2>
            <p>
              The planned <code>refit.yml</code> file defines monitored providers and the validation
              commands required before publication. The example below uses npm; adapt the commands
              to your repository.
            </p>
            <div className="docs-code">
              <div>
                <span>refit.yml</span>
                <CopyButton text={configuration} />
              </div>
              <pre>
                <code>{configuration}</code>
              </pre>
            </div>
            <p>
              The connected pipeline will validate the configuration before using it. Required
              commands must succeed. A missing command, skipped check, or incomplete execution must
              never be reported as a pass.
            </p>
            <Link className="text-link" to="/sample/settings">
              Build an example configuration <ArrowRight />
            </Link>
          </section>
          <section id="review">
            <h2>A patch has to earn its PR.</h2>
            <p>
              The planned pipeline separates source evidence, proposed code, and actual validation.
              The model proposes a migration; deterministic commands decide whether it is ready for
              review.
            </p>
            <ul>
              <li>
                <strong>Inspect the evidence.</strong> Read the provider change, affected files, and
                symbols.
              </li>
              <li>
                <strong>Check the diff.</strong> Review the smallest useful application-code change.
              </li>
              <li>
                <strong>Read validation results.</strong> Each command records its status and exit
                code.
              </li>
              <li>
                <strong>Make the final decision.</strong> Successful migrations become drafts. Refit
                never auto-merges.
              </li>
            </ul>
            <p>
              Work runs in an isolated environment. The intended system provides no production
              secrets to the agent, limits tool access, and retains enough evidence to explain the
              result.
            </p>
          </section>
          <section id="replay">
            <h2>Repeatable runs. Inspectable failures.</h2>
            <p>
              The real replay pipeline is planned to accept two historical Stripe specification
              revisions and a fixture repository, then execute the same ingestion, analysis,
              migration, and validation path as production.
            </p>
            <p>
              The current interactive demo is an illustration of those stages. It does not run that
              pipeline, execute commands, or create a GitHub PR.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Expected behavior</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Unaffected usage</td>
                  <td>No migration and no PR.</td>
                </tr>
                <tr>
                  <td>Uncertain impact</td>
                  <td>Retain evidence and request review.</td>
                </tr>
                <tr>
                  <td>Failed validation</td>
                  <td>Attempt a bounded repair; block publication if checks still fail.</td>
                </tr>
                <tr>
                  <td>Stale repository revision</td>
                  <td>Re-evaluate before applying the migration.</td>
                </tr>
                <tr>
                  <td>Duplicate change</td>
                  <td>Reuse the existing workflow instead of creating another PR.</td>
                </tr>
              </tbody>
            </table>
            <Link className="text-link" to="/demo?scenario=failed">
              Explore the failed-check scenario <ArrowRight />
            </Link>
          </section>
        </main>
      </div>
      <Footer />
    </>
  );
}
