import '@fontsource-variable/archivo/wdth.css';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AsciiVideo } from '../../components/AsciiVideo';
import { AsciiWordmark } from '../../components/AsciiWordmark';
import { WaitlistForm } from '../../components/WaitlistForm';
import { useReducedMotion } from '../../components/Workflow';
import { ClipPlayer, clipDuration } from './film/Film';
import type { FilmTheme, SceneId } from './film/Film';
// A border collie herding sheep, supplied by the founders on 2026-11-03 (by its file name, Pexels
// video 12116088). Cut to 960x540 grey and sharpened, with its end cross-faded into its start so
// it loops.
import herd from './media/herd.mp4';
import { Wordmark } from './shared';
import './premiere.css';

const THEME: FilmTheme = {
  bg: '#000',
  panel: '#121316',
  line: '#2b2d33',
  ink: '#f5f5f6',
  muted: '#9a9ea7',
  accent: '#5b93ff',
  accentInk: '#04102a',
  tint: 'rgba(91, 147, 255, 0.18)',
  added: '#5fd394',
  addedBg: 'rgba(95, 211, 148, 0.13)',
  removed: '#ff8080',
  removedBg: 'rgba(255, 128, 128, 0.14)',
  keyword: '#9dbcff',
  string: '#efc77a',
  pass: '#3fb873',
  warn: '#e3a33b',
  shadow: '0 50px 90px -40px rgba(0, 0, 0, 0.9)',
  radius: 0,
  sans: "'Geist Variable', sans-serif",
  mono: "'Geist Mono Variable', monospace",
  logo: '#ffffff',
};

// Refit, one step per window. The hand-off to the developer's own coding agent closes it.
const STEPS: { scene: SceneId; title: string; line: string }[] = [
  { scene: 'change', title: 'The change', line: 'Slack retires files.upload.' },
  { scene: 'find', title: 'Find', line: 'Refit finds the call in your code.' },
  { scene: 'fix', title: 'Fix', line: 'It writes the fix in a sandbox.' },
  { scene: 'prove', title: 'Prove', line: 'Your checks pass, before and after.' },
  { scene: 'ship', title: 'Ship', line: 'It opens a draft pull request.' },
  { scene: 'brief', title: 'Hand off', line: 'Your coding agent explains it to you.' },
];

// API providers teams build on, one per turn of the headline. All six are in src/logos.
const PROVIDERS = ['Stripe', 'Twilio', 'Slack', 'Shopify', 'OpenAI', 'PayPal'];
const TURN_MS = 3000;

// Wide screens with motion get the sideways walkthrough; elsewhere the steps stack.
const SIDEWAYS = '(min-width: 900px) and (prefers-reduced-motion: no-preference)';
// Share of each screen of scroll held still at a step before the track moves on.
const HOLD = 0.18;
// How long a finished clip stays on screen before the walkthrough moves to the next step.
const BEAT_MS = 400;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

// "Stripe changed. Refit fixed it.", then the next provider, on a loop. Under reduced motion it
// stays on the first.
function Headline() {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const timer = window.setInterval(
      () => setIndex((shown) => (shown + 1) % PROVIDERS.length),
      TURN_MS,
    );
    return () => window.clearInterval(timer);
  }, [reduced]);
  return (
    <h1
      id="premiere-title"
      aria-label="Your API changed. Refit fixed it."
      style={{ '--turn': `${TURN_MS}ms` } as CSSProperties}
    >
      <span key={index} className="premiere-change" aria-hidden="true">
        <span>{PROVIDERS[index]}</span> changed.
      </span>
      <span className="premiere-fixed" aria-hidden="true">
        Refit fixed it.
      </span>
    </h1>
  );
}

// Direction 2: a premiere. The front page, a headline over ASCII footage, slides sideways into
// Refit's steps, one large window at a time, with the scroll locking on each, after the pinned
// horizontal sections on details.so.
// From the first step on, each clip plays through and the page moves itself to the next one. The
// signup closes under the moving ASCII logo.
export function Premiere() {
  const stage = useRef<HTMLElement>(null);
  const beat = useRef(0);
  const [sideways, setSideways] = useState(() => window.matchMedia(SIDEWAYS).matches);
  // 0 is the front page; 1 to 6 are the steps.
  const [current, setCurrent] = useState(0);

  // The browser's own bars, like Safari's on phones, go black with the page while it's open.
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const before = meta.content;
    meta.content = '#000000';
    return () => {
      meta.content = before;
      // index.html starts the homepage black; other pages keep their own background.
      document.documentElement.style.background = '';
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia(SIDEWAYS);
    const change = () => setSideways(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    if (!sideways) return;
    const element = stage.current!;
    const windows = [...element.querySelectorAll<HTMLElement>('.premiere-step')];
    let stops: number[] = [];
    let frame = 0;
    // Where the track rests for each stop: at the start for the front page, then each window
    // centred on the screen.
    const measure = () => {
      stops = [
        0,
        ...windows.map((step) => step.offsetLeft + step.offsetWidth / 2 - window.innerWidth / 2),
      ];
    };
    // Each screen of scroll is one stop; the track holds, eases to the next stop, then holds.
    const update = () => {
      frame = 0;
      const scrolled = Math.max(0, -element.getBoundingClientRect().top) / window.innerHeight;
      const from = Math.min(stops.length - 1, Math.floor(scrolled));
      const to = Math.min(stops.length - 1, from + 1);
      const travel = easeInOut(clamp((scrolled - from - HOLD) / (1 - 2 * HOLD)));
      const position = from + (to - from) * travel;
      element.style.setProperty('--x', `${-(stops[from] + (stops[to] - stops[from]) * travel)}px`);
      element.style.setProperty('--position', String(position));
      windows.forEach((step, index) =>
        step.style.setProperty('--focus', String(clamp(1 - Math.abs(position - index - 1)))),
      );
      setCurrent(Math.round(position));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = () => {
      measure();
      schedule();
    };
    measure();
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', resize);
    };
  }, [sideways]);

  // Leaving a step, by hand or by the walkthrough, drops the move its clip had queued.
  useEffect(() => () => window.clearTimeout(beat.current), [current]);

  // Scrolls to a stop's snap point: 0 is the front page, 1 to 6 the steps.
  const goTo = (stop: number) => {
    const top = stage.current!.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + stop * window.innerHeight, behavior: 'smooth' });
  };
  // The current step's clip has played through: hold a beat, then move on. The last step stays.
  const next = () => {
    window.clearTimeout(beat.current);
    if (current < STEPS.length) beat.current = window.setTimeout(() => goTo(current + 1), BEAT_MS);
  };

  return (
    <div className="dir premiere" id="top">
      <header className="premiere-header">
        <Wordmark />
      </header>
      <main id="main-content">
        <section className="premiere-stage" ref={stage} aria-labelledby="premiere-title">
          {/* One scroll-snap stop per step, a screen apart, so each gesture moves one step. */}
          {STEPS.map((step, index) => (
            <span
              key={step.scene}
              className="premiere-snap"
              style={{ '--stop': index + 1 } as CSSProperties}
              aria-hidden="true"
            />
          ))}
          <div className="premiere-pin">
            <div className="premiere-track">
              <div className="premiere-front">
                <AsciiVideo src={herd} className="premiere-herd" />
                <div className="premiere-hero">
                  <Headline />
                  <WaitlistForm />
                </div>
              </div>
              <ol className="premiere-steps" aria-label="How Refit works, step by step">
                {STEPS.map((step, index) => (
                  <li
                    key={step.scene}
                    className="premiere-step"
                    aria-current={sideways && current === index + 1 ? 'step' : undefined}
                  >
                    <ClipPlayer
                      scene={step.scene}
                      theme={THEME}
                      label={step.line}
                      active={sideways ? current === index + 1 : undefined}
                      onEnd={sideways && current === index + 1 ? next : undefined}
                    />
                    <p>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      {step.line}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
            {/* Where the walkthrough is. The current step's bar fills as its clip plays. */}
            <ol className={`premiere-rail${current ? ' is-on' : ''}`} aria-label="Go to a step">
              {STEPS.map((step, index) => (
                <li
                  key={step.scene}
                  className={
                    current === index + 1 ? 'is-current' : current > index + 1 ? 'is-done' : ''
                  }
                  style={{ '--duration': `${clipDuration(step.scene)}ms` } as CSSProperties}
                >
                  <button
                    type="button"
                    onClick={() => goTo(index + 1)}
                    aria-current={current === index + 1 ? 'step' : undefined}
                  >
                    {step.title}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="premiere-close" id="join" aria-labelledby="premiere-join">
          <h2 id="premiere-join">
            Stop chasing
            <span>API changelogs.</span>
          </h2>
          <WaitlistForm />
        </section>
        <AsciiWordmark columns={150} glint className="premiere-logo" />
      </main>
      <footer className="premiere-footer">
        <p>The steps are illustrative.</p>
        <p>© 2026 Refit</p>
      </footer>
    </div>
  );
}
