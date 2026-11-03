import '@fontsource-variable/archivo/wdth.css';
import { AsciiWordmark } from '../../components/AsciiWordmark';
import { WaitlistForm } from '../../components/WaitlistForm';
import { ClipPlayer, FilmPlayer } from './film/Film';
import type { FilmTheme, SceneId } from './film/Film';
import { Wordmark } from './shared';
import './harbor.css';

const THEME: FilmTheme = {
  bg: '#0c0d0f',
  panel: '#16181c',
  line: '#2a2d33',
  ink: '#f2f3f5',
  muted: '#9298a3',
  accent: '#4d8dff',
  accentInk: '#06122b',
  tint: 'rgba(77, 141, 255, 0.16)',
  added: '#56d38a',
  addedBg: 'rgba(86, 211, 138, 0.12)',
  removed: '#ff7b7b',
  removedBg: 'rgba(255, 123, 123, 0.14)',
  keyword: '#8fb5ff',
  string: '#e9c46a',
  pass: '#3fb873',
  warn: '#e3a33b',
  shadow: '0 40px 80px -30px rgba(0, 0, 0, 0.7)',
  radius: 18,
  sans: "'Archivo Variable', sans-serif",
  mono: "'Geist Mono Variable', monospace",
};

const TILES: { scene: SceneId; lead: string; text: string }[] = [
  { scene: 'change', lead: 'Reads the changelog.', text: 'Every provider your code calls.' },
  { scene: 'find', lead: 'Finds your call sites.', text: 'Down to the line.' },
  { scene: 'fix', lead: 'Writes the fix.', text: 'In a sandboxed copy.' },
  { scene: 'prove', lead: 'Proves it works.', text: 'Your checks, before and after.' },
];

// Direction 1: a dark page after maritime.sh, set in Archivo. The moving ASCII Refit mark fills
// the hero; the film and looping shots explain the product, down to the coding agent that explains
// each pull request to the developer.
export function Harbor() {
  return (
    <div className="dir harbor" id="top">
      <header className="harbor-header">
        <Wordmark />
        <a href="#join">Join the waitlist</a>
      </header>
      <main id="main-content">
        <section className="harbor-hero">
          <AsciiWordmark columns={64} word={false} glint className="harbor-ascii" />
          <div className="harbor-hero-copy">
            <h1>
              Your APIs change.
              <span>Your code keeps up.</span>
            </h1>
            <p>
              Refit fixes the code, opens the pull request and briefs your team’s coding agents.
            </p>
            <WaitlistForm />
          </div>
        </section>

        <FilmPlayer theme={THEME} className="harbor-film" />

        <section className="harbor-brief" aria-labelledby="harbor-brief">
          <div className="harbor-brief-copy">
            <h2 id="harbor-brief">
              No one stops to review.
              <span>Their agent explains it.</span>
            </h2>
            <p>
              Refit hands each pull request to your developers’ coding agents, like Claude. They
              explain it where the work happens.
            </p>
          </div>
          <ClipPlayer scene="brief" theme={THEME} label="the agent briefing" />
        </section>

        <section className="harbor-steps" aria-labelledby="harbor-steps">
          <h2 id="harbor-steps">
            From changelog
            <span>to pull request.</span>
          </h2>
          <div className="harbor-tiles">
            {TILES.map((tile) => (
              <figure key={tile.scene}>
                <ClipPlayer scene={tile.scene} theme={THEME} label={tile.lead} />
                <figcaption>
                  <strong>{tile.lead}</strong> {tile.text}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="harbor-close" id="join" aria-labelledby="harbor-join">
          <h2 id="harbor-join">
            Stop chasing
            <span>API changelogs.</span>
          </h2>
          <WaitlistForm />
        </section>
      </main>
      <footer className="harbor-footer">
        <p>Examples are illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
