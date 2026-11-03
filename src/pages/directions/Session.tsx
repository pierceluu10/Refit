import '@fontsource-variable/martian-mono/wdth.css';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { WaitlistForm } from '../../components/WaitlistForm';
import { FilmPlayer } from './film/Film';
import type { FilmTheme } from './film/Film';
import { EXAMPLE, LIMITS, Wordmark } from './shared';
import './session.css';

const THEME: FilmTheme = {
  bg: '#00349e',
  panel: '#0048d8',
  line: 'rgba(255, 255, 255, 0.3)',
  ink: '#ffffff',
  muted: '#c4d4fa',
  accent: '#ffffff',
  accentInk: '#0048d8',
  tint: 'rgba(255, 255, 255, 0.14)',
  added: '#a6f4c5',
  addedBg: 'rgba(166, 244, 197, 0.16)',
  removed: '#ffc2c2',
  removedBg: 'rgba(255, 194, 194, 0.16)',
  keyword: '#ffffff',
  string: '#ffe08a',
  pass: '#1f9d55',
  warn: '#d97706',
  shadow: 'none',
  radius: 0,
  sans: "'Martian Mono Variable', monospace",
  // Martian Mono is too wide for the film's longest code line.
  mono: "'Geist Mono Variable', monospace",
};

// One illustrative session on a made-up repository, as [time, verb, detail]. A line without a time
// is a comment.
const TRANSCRIPT: [string, string, string][] = [
  ['09:14:02', 'read', `${EXAMPLE.repository}, 214 files`],
  ['09:14:31', 'found', 'slack   @slack/web-api 6.9.0, 1 call site'],
  ['09:14:31', 'found', 'openai  raw https, 2 call sites'],
  ['09:14:31', 'found', 'twilio  node sdk 4.19.0, 3 call sites'],
  ['09:14:32', 'watch', '3 changelogs, 3 sdk release feeds'],
  ['', '', '# 13 days later'],
  ['11:02:47', 'change', `slack retires ${EXAMPLE.oldMethod}`],
  ['11:02:49', 'match', `1 call site in ${EXAMPLE.file}`],
  ['11:02:50', 'migrate', `sandboxed copy: ${EXAMPLE.oldMethod} → ${EXAMPLE.newMethod}`],
  ['11:04:12', 'prove', 'type check pass → pass, build pass → pass, tests 41 → 41'],
  ['11:04:15', 'ship', `draft pull request #${EXAMPLE.number}: ${EXAMPLE.title}`],
  ['11:04:16', 'brief', 'sent to your coding agent, which explains it to you'],
  ['11:04:16', 'note', 'unproven: callers that pass several channels'],
];

// Direction 6: the page is one agent session on a royal-blue field. The transcript plays once,
// line by line, when it comes into view; the film shows the same run.
export function Session() {
  const log = useRef<HTMLOListElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setPlaying(true);
        observer.disconnect();
      },
      { threshold: 0.35 },
    );
    observer.observe(log.current!);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="dir session" id="top">
      <header className="session-header">
        <Wordmark />
        <a href="#join">Join the waitlist</a>
      </header>
      <main id="main-content" className="session-main">
        <section className="session-hero">
          <h1>
            APIs change.
            <br />
            Your code keeps up.
          </h1>
          <p className="session-command" aria-hidden="true">
            ~/acme $ refit --help
          </p>
          <p className="session-lede">
            Refit fixes the code an API change breaks, then opens a pull request.
          </p>
          <WaitlistForm />
        </section>

        <figure className="session-window">
          <figcaption>
            session <span>{EXAMPLE.repository}</span> illustrative
          </figcaption>
          <ol ref={log} className={`session-log ${playing ? 'is-playing' : ''}`}>
            {TRANSCRIPT.map(([time, verb, detail], index) => (
              <li
                key={index}
                className={time ? `is-${verb}` : 'is-comment'}
                style={{ '--n': index } as CSSProperties}
              >
                {time && <span className="session-time">{time}</span>}
                {time && <span className="session-verb">{verb}</span>}
                <span className="session-detail">{detail}</span>
              </li>
            ))}
            <li
              className="session-cursor"
              aria-hidden="true"
              style={{ '--n': TRANSCRIPT.length } as CSSProperties}
            />
          </ol>
        </figure>

        <section className="session-block" aria-labelledby="session-film">
          <h2 id="session-film">
            <span aria-hidden="true"># </span>Watch it work
          </h2>
          <p className="session-command" aria-hidden="true">
            $ refit demo
          </p>
          <FilmPlayer theme={THEME} />
        </section>

        <section className="session-block" aria-labelledby="session-limits">
          <h2 id="session-limits">
            <span aria-hidden="true"># </span>What it never does
          </h2>
          <p className="session-command" aria-hidden="true">
            $ refit help limits
          </p>
          <ul className="session-limits">
            {LIMITS.map((limit) => (
              <li key={limit}>
                <span className="session-rule" aria-hidden="true">
                  rule
                </span>
                {limit}
              </li>
            ))}
          </ul>
        </section>

        <section className="session-block" id="join" aria-labelledby="session-join">
          <h2 id="session-join">
            <span aria-hidden="true"># </span>Get early access
          </h2>
          <p className="session-command" aria-hidden="true">
            $ refit join
          </p>
          <WaitlistForm />
        </section>
      </main>
      <footer className="session-footer">
        <p>The session and film are illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
