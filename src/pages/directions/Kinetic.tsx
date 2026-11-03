import '@fontsource-variable/archivo/wdth.css';
import { useEffect, useState } from 'react';
import { WaitlistForm } from '../../components/WaitlistForm';
import { useReducedMotion } from '../../components/Workflow';
import { FilmPlayer } from './film/Film';
import type { FilmTheme } from './film/Film';
import { Wordmark } from './shared';
import './kinetic.css';

const THEME: FilmTheme = {
  bg: '#f1f2f4',
  panel: '#ffffff',
  line: '#d9dce2',
  ink: '#000000',
  muted: '#555b66',
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
  shadow: '0 30px 60px -32px rgba(0, 0, 0, 0.3)',
  radius: 16,
  sans: "'Archivo Variable', sans-serif",
  mono: "'Geist Mono Variable', monospace",
};

const PROVIDERS = ['Slack', 'Twilio', 'Shopify', 'OpenAI'];
const STEP_MS = 1150;

// Runs through the providers once, inside five seconds, then rests on Slack, the film's example.
function Provider() {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const timers = PROVIDERS.map((_, step) =>
      window.setTimeout(() => setIndex((step + 1) % PROVIDERS.length), STEP_MS * (step + 1)),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [reduced]);
  return (
    <span key={index} className="kinetic-word">
      {PROVIDERS[index]}
    </span>
  );
}

// Direction 5: a title sequence. The provider's name unfolds on the width axis, then the film runs.
export function Kinetic() {
  return (
    <div className="dir kinetic" id="top">
      <header className="kinetic-header">
        <Wordmark />
        <a href="#join">Join the waitlist</a>
      </header>
      <main id="main-content">
        <section className="kinetic-hero">
          <h1 aria-label="Your API changed. Refit fixed it.">
            <span aria-hidden="true">
              <Provider /> changed.
            </span>
            <span className="kinetic-fixed" aria-hidden="true">
              Refit fixed it.
            </span>
          </h1>
          <div className="kinetic-cta">
            <p>Refit fixes the code an API change breaks.</p>
            <WaitlistForm />
          </div>
        </section>
        <FilmPlayer theme={THEME} tagline="Refit fixed it." className="kinetic-film" />
        <section className="kinetic-join" id="join" aria-labelledby="kinetic-join">
          <h2 id="kinetic-join">Be ready for the next change.</h2>
          <WaitlistForm />
        </section>
      </main>
      <footer className="kinetic-footer">
        <p>The film is illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
