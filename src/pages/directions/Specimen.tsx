import { CheckCircle } from '@phosphor-icons/react';
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { WaitlistForm } from '../../components/WaitlistForm';
import { FilmPlayer } from './film/Film';
import type { FilmTheme } from './film/Film';
import { Diff, EXAMPLE, Wordmark } from './shared';
import './specimen.css';

const THEME: FilmTheme = {
  bg: '#f3f5f8',
  panel: '#ffffff',
  line: '#d8dde5',
  ink: '#000000',
  muted: '#5b6170',
  accent: '#0048d8',
  accentInk: '#ffffff',
  tint: 'rgba(0, 72, 216, 0.08)',
  added: '#1a7f37',
  addedBg: '#e6ffec',
  removed: '#cf222e',
  removedBg: '#ffebe9',
  keyword: '#0048d8',
  string: '#0a3069',
  pass: '#1a7f37',
  warn: '#9a6700',
  shadow: '0 30px 60px -30px rgba(15, 23, 42, 0.25)',
  radius: 14,
  sans: "'Geist Variable', sans-serif",
  mono: "'Geist Mono Variable', monospace",
};

// Each part of the pull request, with the note that points at it from the left or right margin.
const parts: { note: string; side: 'left' | 'right'; body: ReactNode }[] = [
  {
    side: 'right',
    note: 'A draft, on its own branch.',
    body: (
      <div className="specimen-title">
        <h3>
          {EXAMPLE.title} <span>#{EXAMPLE.number}</span>
        </h3>
        <p>
          <span className="specimen-draft">Draft</span>
          refit-agent wants to merge 1 commit into <code>main</code> from{' '}
          <code>{EXAMPLE.branch}</code>
        </p>
      </div>
    ),
  },
  {
    side: 'left',
    note: 'Cites the provider’s changelog.',
    body: (
      <>
        <h4>Why</h4>
        <p>
          {EXAMPLE.provider} retired <code>{EXAMPLE.oldMethod}</code>. This code now calls{' '}
          <code>{EXAMPLE.newMethod}</code>, which takes one <code>channel_id</code> instead of{' '}
          <code>channels</code>.
        </p>
        <p className="specimen-source">Source: {EXAMPLE.provider} API changelog</p>
      </>
    ),
  },
  {
    side: 'right',
    note: 'Only the lines that matter.',
    body: (
      <>
        <h4>What changed</h4>
        <p className="specimen-file">
          <code>{EXAMPLE.file}</code>
          <span className="specimen-plus">+2</span>
          <span className="specimen-minus">−2</span>
        </p>
        <Diff />
      </>
    ),
  },
  {
    side: 'left',
    note: 'Your checks, before and after.',
    body: (
      <>
        <h4>Proof</h4>
        <table className="specimen-checks">
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {EXAMPLE.checks.map((check) => (
              <tr key={check.name}>
                <th scope="row">{check.name}</th>
                <td>
                  <CheckCircle weight="fill" /> {check.before}
                </td>
                <td>
                  <CheckCircle weight="fill" /> {check.after}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    ),
  },
  {
    side: 'right',
    note: 'Says what it couldn’t prove.',
    body: (
      <>
        <h4>Unproven</h4>
        <p>{EXAMPLE.unproven}</p>
      </>
    ),
  },
  {
    side: 'left',
    note: 'You merge. Refit never does.',
    body: (
      <p className="specimen-outcome">
        <span className="specimen-verified">
          <CheckCircle weight="fill" /> Verified
        </span>
        Behaviour change: none expected.
      </p>
    ),
  },
];

// Direction 8: the pull request is the product. The film shows it being made; below, the finished
// one is laid out as a specimen with notes that draw in from the margins.
export function Specimen() {
  return (
    <div className="dir specimen" id="top">
      <header className="specimen-header">
        <Wordmark />
        <a href="#join">Join the waitlist</a>
      </header>
      <main id="main-content">
        <section className="specimen-hero">
          <h1>Your API changed. Here’s the pull request.</h1>
          <WaitlistForm />
        </section>

        <FilmPlayer theme={THEME} className="specimen-film" />

        <section className="specimen-stage" aria-labelledby="specimen-caption">
          <p id="specimen-caption" className="specimen-caption">
            Illustrative example: {EXAMPLE.provider} retires {EXAMPLE.oldMethod} in a sample
            repository.
          </p>
          <div className="specimen-grid">
            {parts.map((part, index) => (
              <Fragment key={index}>
                <p className={`specimen-note is-${part.side}`} style={{ gridRow: index + 1 }}>
                  <span className="specimen-note-text">{part.note}</span>
                  <span className="specimen-leader" aria-hidden="true" />
                </p>
                <div className="specimen-part" style={{ gridRow: index + 1 }}>
                  {part.body}
                </div>
              </Fragment>
            ))}
          </div>
        </section>

        <section className="specimen-join" id="join" aria-labelledby="specimen-join">
          <h2 id="specimen-join">Get the first pull request for your codebase.</h2>
          <WaitlistForm />
        </section>
      </main>
      <footer className="specimen-footer">
        <p>The film and pull request are illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
