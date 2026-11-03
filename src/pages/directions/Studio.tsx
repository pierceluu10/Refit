import { WaitlistForm } from '../../components/WaitlistForm';
import { FilmPlayer } from './film/Film';
import type { FilmTheme } from './film/Film';
import { Wordmark } from './shared';
import './studio.css';

const THEME: FilmTheme = {
  bg: '#0f1013',
  panel: '#1b1d22',
  line: '#30333a',
  ink: '#eceef1',
  muted: '#9096a0',
  accent: '#8aa2ff',
  accentInk: '#0b1033',
  tint: 'rgba(138, 162, 255, 0.16)',
  added: '#6ee7a8',
  addedBg: 'rgba(110, 231, 168, 0.12)',
  removed: '#ff8f8f',
  removedBg: 'rgba(255, 143, 143, 0.13)',
  keyword: '#b4c3ff',
  string: '#f6c177',
  pass: '#3fb873',
  warn: '#e3a33b',
  shadow: '0 30px 60px -30px rgba(0, 0, 0, 0.8)',
  radius: 10,
  sans: "'Geist Variable', sans-serif",
  mono: "'Geist Mono Variable', monospace",
};

// Direction 3: the page is a motion editor. The film sits in the viewer and each step is a track
// under a playhead; click a track to jump to it.
export function Studio() {
  return (
    <div className="dir studio" id="top">
      <header className="studio-header">
        <Wordmark />
        <a href="#join">Join the waitlist</a>
      </header>
      <main id="main-content">
        <section className="studio-intro">
          <h1>Watch Refit fix an API change.</h1>
          <WaitlistForm />
        </section>
        <div className="studio-window">
          <FilmPlayer theme={THEME} controls="timeline" className="studio-film" />
        </div>
        <section className="studio-join" id="join" aria-labelledby="studio-join">
          <h2 id="studio-join">Get it on your repositories.</h2>
          <WaitlistForm />
        </section>
      </main>
      <footer className="studio-footer">
        <p>The film is illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
