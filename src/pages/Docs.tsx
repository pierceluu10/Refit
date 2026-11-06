import { ArrowRight, BookOpen } from '@phosphor-icons/react';
import { Link, useLocation } from 'react-router-dom';
import { CopyButton } from '../components/CopyButton';
import { Header, Footer } from '../components/Layout';
import './docs.css';

const refitFile = `paused: true # stop scans and PRs for this repo
ignore: # dependencies Refit should leave alone
  - stripe
  - node
`;

const topics = [
  { id: 'what-refit-watches', title: 'What Refit watches' },
  { id: 'what-a-pr-contains', title: 'What a PR contains' },
  { id: 'hard-limits', title: 'The hard limits' },
  { id: 'pause-or-ignore', title: 'Pause or ignore' },
];

const watched = [
  ['Language runtimes', 'Node.js and Python versions reaching end of life'],
  ['Frameworks', 'New major versions of Next.js, React, Express, Flask and Django'],
  ['Libraries', 'Any npm or PyPI package with a breaking major version'],
  ['Security advisories', 'OSV and GitHub advisories whose fix needs a code change'],
  ['AI models', 'OpenAI, Anthropic and Google model retirements'],
  ['Third-party APIs', 'Changes to APIs such as Stripe, OpenAI and Shopify'],
  ['Container images', 'Dockerfile base images and OS versions reaching end of life'],
  ['CI', 'Deprecated GitHub Actions and runner versions'],
  [
    'Kubernetes and cloud',
    'Kubernetes API removals and version end of life, managed cluster calendars, cloud service shutdowns',
  ],
  [
    'Serverless runtimes',
    'AWS Lambda, Google Cloud Functions and Azure Functions runtimes retiring',
  ],
  [
    'App stores and mobile',
    'Apple and Google Play requirements, iOS and Android behaviour changes',
  ],
  ['Browsers', 'Chrome, Safari and Firefox removals, extension Manifest V3'],
  ['Encryption and login', 'TLS and certificate changes, OAuth and password-login retirements'],
  ['Payment rules', 'Strong Customer Authentication in Europe, PCI DSS rules for payment pages'],
  [
    'Laws and regulations',
    'Accessibility (European Accessibility Act), privacy (GDPR, CCPA), AI laws (EU AI Act)',
  ],
];

const hardLimits = [
  'Untrusted repo code runs only in the sandbox.',
  'A run-level dollar cap.',
  'PRs only, never pushing to the default branch and never merging.',
  'Never printing or committing secrets.',
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
                className={(hash || `#${topics[0].id}`) === `#${topic.id}` ? 'selected' : ''}
              >
                {topic.title}
              </a>
            ))}
          </nav>
        </aside>
        <main id="main-content" className="docs-content">
          <section>
            <h1>How Refit works.</h1>
            <p className="docs-lead">
              Refit watches what your code depends on. When something changes, it opens a draft PR
              with the fix and what it checked.
            </p>
            <Link className="button button-primary" to="/onboarding">
              Get started <ArrowRight />
            </Link>
            <p>
              Looking for what it costs? See <Link to="/pricing">pricing</Link>.
            </p>
          </section>
          <section id="what-refit-watches">
            <h2>What Refit watches</h2>
            <p>
              Refit works out what each repo depends on, then looks for changes outside your code
              that could force it to change.
            </p>
            <table>
              <caption className="sr-only">What Refit watches, with examples</caption>
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">For example</th>
                </tr>
              </thead>
              <tbody>
                {watched.map(([name, examples]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{examples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="docs-callout">
              <strong>Rules work differently.</strong>
              <p>
                Refit never claims a codebase is compliant and never gives legal advice. For a rule,
                it finds the code the rule likely touches, makes the change the rule’s text points
                to, checks what a tool can check, and opens a needs-review PR listing what a person
                or lawyer must confirm.
              </p>
            </div>
            <p>
              Refit works in JavaScript, TypeScript and Python today. Code in other languages is
              found and reported, and still gets a needs-review PR with notes.
            </p>
          </section>
          <section id="what-a-pr-contains">
            <h2>What a PR contains</h2>
            <p>Every PR from Refit has the same parts, so you know where to look.</p>
            <ul>
              <li>
                <strong>The change.</strong> What changed outside your code, with a link to the
                source and a quote from it.
              </li>
              <li>
                <strong>The checks.</strong> What Refit ran before and after its edit, and what each
                one reported.
              </li>
              <li>
                <strong>What’s unproven.</strong> Anything Refit couldn’t confirm, written down for
                whoever reviews it.
              </li>
            </ul>
            <p>Every PR is a draft, and Refit never merges one. Merging is up to you.</p>
          </section>
          <section id="hard-limits">
            <h2>The hard limits</h2>
            <p>Four limits, enforced in code.</p>
            <ul>
              {hardLimits.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </section>
          <section id="pause-or-ignore">
            <h2>
              Pause or ignore with <code>.refit.yml</code>
            </h2>
            <p>
              Add a <code>.refit.yml</code> file at the root of a repo to stop Refit there or to
              skip a dependency. The file is optional and your choice to make. For example:
            </p>
            <div className="docs-code">
              <div>
                <span>.refit.yml</span>
                <CopyButton text={refitFile} />
              </div>
              <pre>
                <code>{refitFile}</code>
              </pre>
            </div>
            <p>
              Each name under <code>ignore</code> matches a dependency or API by name, in any case.
            </p>
            <p>
              A malformed or unknown entry never stops a scan. It’s listed in the report’s errors on
              the <Link to="/app">What’s behind</Link> page, and the valid parts still apply.
            </p>
          </section>
        </main>
      </div>
      <Footer />
    </>
  );
}
