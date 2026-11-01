import { ArrowRight, BookOpen, Info } from '@phosphor-icons/react';
import { Link, useLocation } from 'react-router-dom';
import { Header, Footer } from '../components/Layout';
import './docs.css';

const topics = [
  { id: 'introduction', title: 'Introduction' },
  { id: 'scope', title: 'Supported scope' },
  { id: 'installation', title: 'GitHub installation' },
  { id: 'understanding', title: 'Understanding your code' },
  { id: 'review', title: 'Proof & review' },
  { id: 'outcomes', title: 'Outcomes' },
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
        </aside>
        <main id="main-content" className="docs-content">
          <section id="introduction">
            <h1>Meet Aptitude.</h1>
            <p className="docs-lead">
              A GitHub App that keeps your code current with the APIs it depends on.
            </p>
            <div className="demo-notice">
              <Info size={18} />
              <span>
                <strong>In development.</strong> Nothing is live and there is no GitHub connection
                yet. The demo and dashboard contain labeled sample data.
              </span>
            </div>
            <p>
              Aptitude is designed to read each repository, map every external API it uses, watch
              those APIs for changes, migrate the affected code in a sandbox, prove the result, and
              open a pull request. You keep the review and the merge.
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
            <h2>Any API it finds. Five watchers first.</h2>
            <p>
              The agent records every external API in your code. Watching for changes needs a
              provider watcher, and the first ones are planned for the providers below.
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
                  <td>API discovery</td>
                  <td>Any provider, through SDKs, raw HTTP, GraphQL or webhooks</td>
                </tr>
                <tr>
                  <td>Provider watchers</td>
                  <td>Stripe, Shopify, Meta Graph, OpenAI and Twilio</td>
                </tr>
                <tr>
                  <td>Source of changes</td>
                  <td>Changelogs, SDK releases and deprecation notices; specs when available</td>
                </tr>
                <tr>
                  <td>Source control</td>
                  <td>GitHub, through a GitHub App</td>
                </tr>
                <tr>
                  <td>Result</td>
                  <td>
                    A pull request marked verified or needs-review, or a “not affected” verdict
                  </td>
                </tr>
              </tbody>
            </table>
            <p>
              The preview illustrates a PaymentIntent field migration. Its sample code is
              explanatory, not a universal Stripe upgrade recipe. A real migration must use the
              repository’s exact API and SDK versions.
            </p>
          </section>
          <section id="installation">
            <h2>Connect only what you choose.</h2>
            <p>
              GitHub installation is not available yet. The planned flow uses a GitHub App, so an
              org admin selects repositories rather than handing over a personal access token.
            </p>
            <ol>
              <li>Review the app’s requested permissions in GitHub.</li>
              <li>Install it on your organization, for all repositories or selected ones.</li>
              <li>Aptitude reads each repository and builds its API usage map.</li>
              <li>It re-reads on every push and watches the APIs it found.</li>
            </ol>
            <p>
              The planned permissions cover repository metadata, code access, migration branches,
              and pull requests. The final permission list must be reviewed against the implemented
              GitHub App before launch. Aptitude must not request customer production API keys.
            </p>
            <div className="docs-callout">
              <strong>Nothing is connected in this release.</strong>
              <p>
                The sample dashboard runs in your browser and does not read your GitHub account or
                repositories.
              </p>
            </div>
          </section>
          <section id="understanding">
            <h2>It reads your code like a new engineer.</h2>
            <p>For every external API, the agent records:</p>
            <ul>
              <li>
                <strong>The provider.</strong> Any provider, not a fixed list.
              </li>
              <li>
                <strong>How it is called.</strong> An SDK and its version, raw HTTP, GraphQL, or
                webhooks.
              </li>
              <li>
                <strong>The pinned version.</strong> Which version is set, and where.
              </li>
              <li>
                <strong>Every call site.</strong> What it sends, and what the code does with the
                response.
              </li>
            </ul>
            <p>
              Fast scanners for manifests, imports and hosts point the agent at likely files. The
              agent’s reading is the source of truth, so it finds APIs no scanner knows.
            </p>
          </section>
          <section id="review">
            <h2>A patch has to earn its label.</h2>
            <p>
              Each migration runs in a sandboxed copy of your repository. The agent runs the type
              check, build and tests before and after its edit, and counts only new failures. It can
              also call provider validators, such as schema checks.
            </p>
            <ul>
              <li>
                <strong>Inspect the evidence.</strong> Read the provider change, its source, and the
                affected call sites.
              </li>
              <li>
                <strong>Check the diff.</strong> Review the smallest useful application-code change.
              </li>
              <li>
                <strong>Read the proof.</strong> Each check records its result before and after.
              </li>
              <li>
                <strong>Read what is unproven.</strong> The PR says what the checks could not show,
                and any behavior change.
              </li>
              <li>
                <strong>Make the final decision.</strong> Aptitude never merges and never pushes to
                your default branch.
              </li>
            </ul>
            <p>
              Untrusted repository code is planned to run only in the sandbox. Each run has a dollar
              cap, and secrets are never printed or committed.
            </p>
          </section>
          <section id="outcomes">
            <h2>Every task ends in an answer.</h2>
            <p>
              No silent stops. Each task ends in a pull request or a “not affected” verdict, with an
              honest note on what is unproven.
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
                  <td>Verified</td>
                  <td>A pull request. Checks pass with no new failures.</td>
                </tr>
                <tr>
                  <td>Needs review</td>
                  <td>A pull request that says exactly what is unproven, and why.</td>
                </tr>
                <tr>
                  <td>Not affected</td>
                  <td>A verdict with its reason. No migration and no PR.</td>
                </tr>
                <tr>
                  <td>Uncertain impact</td>
                  <td>The agent tries anyway and says so in the PR.</td>
                </tr>
                <tr>
                  <td>Merged, closed or edited</td>
                  <td>Recorded, so future runs learn what worked.</td>
                </tr>
              </tbody>
            </table>
            <p>
              The interactive demo illustrates these outcomes. It does not run the pipeline, execute
              commands, or create a pull request.
            </p>
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
