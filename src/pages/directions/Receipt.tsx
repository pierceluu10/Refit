import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import type { CSSProperties } from 'react';
import { Mark } from '../../components/Brand';
import { WaitlistForm } from '../../components/WaitlistForm';
import { FilmPlayer } from './film/Film';
import type { FilmTheme } from './film/Film';
import { EXAMPLE, Wordmark } from './shared';
import './receipt.css';

const THEME: FilmTheme = {
  bg: '#d9dee6',
  panel: '#ffffff',
  line: '#c3c9d3',
  ink: '#000000',
  muted: '#474e5d',
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
  shadow: '0 24px 40px -24px rgba(16, 24, 40, 0.35)',
  radius: 12,
  sans: "'Archivo Variable', sans-serif",
  mono: "'IBM Plex Mono', monospace",
};

// Bar widths for the decorative barcode, taken from the pull request title so they never change.
const BARS = Array.from(EXAMPLE.title, (character) => (character.charCodeAt(0) % 3) + 1);

// The hard limits from shared.tsx, phrased as things that can't appear on a receipt.
const NEVER = [
  'Merged by Refit',
  'Pushed to your default branch',
  'Run outside the sandbox',
  'A secret',
];

function Paper() {
  return (
    <article className="receipt-paper" aria-label="An illustrative receipt for one Refit run">
      <header className="receipt-paper-head">
        <Mark />
        <strong>Refit</strong>
        <span>run 0412, {EXAMPLE.repository}</span>
        <span>2026-11-02 11:04 UTC</span>
      </header>
      <section>
        <p className="receipt-label">Upstream change</p>
        <p>slack web api</p>
        <p>{EXAMPLE.oldMethod} retired</p>
        <p className="receipt-quiet">source: slack api changelog</p>
      </section>
      <section>
        <p className="receipt-row receipt-label">
          <span>Call sites</span>
          <span>{EXAMPLE.callSites.length}</span>
        </p>
        {EXAMPLE.callSites.map((site) => (
          <p key={site}>{site.replace('src/', '')}</p>
        ))}
      </section>
      <section>
        <p className="receipt-row">
          <span className="receipt-label">Edit</span>
          <span>+2 −2</span>
        </p>
      </section>
      <section>
        <p className="receipt-checks receipt-label">
          <span>Checks</span>
          <span>before</span>
          <span>after</span>
        </p>
        {EXAMPLE.checks.map((check) => (
          <p key={check.name} className="receipt-checks">
            <span>{check.name.toLowerCase()}</span>
            <span>{check.before.replace(' passed', '')}</span>
            <span>{check.after.replace(' passed', '')}</span>
          </p>
        ))}
      </section>
      <section>
        <p className="receipt-label">Unproven</p>
        <p>callers passing several channels</p>
      </section>
      <section>
        <p className="receipt-row">
          <span>model spend</span>
          <span>$0.84</span>
        </p>
        <p className="receipt-row">
          <span>run cap</span>
          <span>$5.00</span>
        </p>
      </section>
      <section className="receipt-total">
        <p className="receipt-row">
          <span>Draft pull request #{EXAMPLE.number}</span>
          <span>opened</span>
        </p>
        <p className="receipt-quiet">briefed: your coding agent</p>
        <p className="receipt-stamp">Verified</p>
      </section>
      <section>
        <p className="receipt-row">
          <span>merged by refit</span>
          <span>never</span>
        </p>
      </section>
      <div className="receipt-barcode" aria-hidden="true">
        {BARS.map((width, index) => (
          <span key={index} style={{ '--bar': width } as CSSProperties} />
        ))}
      </div>
      <p className="receipt-quiet receipt-center">illustrative example</p>
    </article>
  );
}

// Direction 9: every run comes with an itemized receipt. It prints once on load, the stamp lands,
// and the film shows the run it records.
export function Receipt() {
  return (
    <div className="dir receipt" id="top">
      <header className="receipt-header">
        <Wordmark />
        <a href="#join">Join the waitlist</a>
      </header>
      <main id="main-content">
        <section className="receipt-hero">
          <div className="receipt-copy">
            <h1>Every migration comes with a receipt.</h1>
            <p>Refit fixes the code an API change breaks, and itemizes the proof.</p>
            <WaitlistForm />
          </div>
          <div className="receipt-printer">
            <div className="receipt-slot" aria-hidden="true" />
            <div className="receipt-feed">
              <Paper />
            </div>
          </div>
        </section>

        <section className="receipt-section" aria-labelledby="receipt-film">
          <h2 id="receipt-film">Watch the run it records.</h2>
          <FilmPlayer theme={THEME} />
        </section>

        <section className="receipt-section receipt-never" aria-labelledby="receipt-never">
          <h2 id="receipt-never">Never on a receipt</h2>
          <ul>
            {NEVER.map((entry) => (
              <li key={entry}>
                <s>{entry}</s>
              </li>
            ))}
          </ul>
        </section>

        <section className="receipt-join" id="join" aria-labelledby="receipt-join">
          <h2 id="receipt-join">Get early access</h2>
          <WaitlistForm />
        </section>
      </main>
      <footer className="receipt-footer">
        <p>The receipt and film are illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
