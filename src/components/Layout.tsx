import { ArrowRight, ArrowUpRight, GithubLogo, List, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { PROJECT_URL } from '../data';
import { Brand } from './Brand';

// `minimal` is the waitlist page's header: the brand and one call to action, no navigation.
export function Header({ minimal = false }: { minimal?: boolean }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location]);
  if (minimal)
    return (
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <a className="button button-small button-dark" href="#waitlist">
            Join the waitlist <ArrowRight />
          </a>
        </div>
      </header>
    );
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <button
          className="icon-button menu-toggle"
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          aria-expanded={open}
          aria-controls="main-navigation"
          onClick={() => setOpen(!open)}
        >
          {open ? <X /> : <List />}
        </button>
        <nav
          id="main-navigation"
          className={`main-navigation ${open ? 'is-open' : ''}`}
          aria-label="Main navigation"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
              document.querySelector<HTMLButtonElement>('.menu-toggle')?.focus();
            }
          }}
        >
          <a href="/#how-it-works" onClick={() => setOpen(false)}>
            How it works
          </a>
          <a href="/#demo" onClick={() => setOpen(false)}>
            Demo
          </a>
          <NavLink to="/docs">Docs</NavLink>
          <a className="github-link" href={PROJECT_URL} target="_blank" rel="noreferrer">
            <GithubLogo weight="bold" /> GitHub <ArrowUpRight size={12} />
          </a>
          <a className="button button-small button-dark" href="/#waitlist">
            Join the waitlist <ArrowRight />
          </a>
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <Brand />
        <p>Built for the next API change.</p>
        <div>
          <Link to="/docs">Documentation</Link>
          <a href={PROJECT_URL} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight size={13} />
          </a>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} Refit</span>
        <span>Open source. Human reviewed.</span>
        <span className="footer-status">
          <span /> In development
        </span>
      </div>
    </footer>
  );
}

export function PagePosition() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const target = hash ? document.getElementById(hash.slice(1)) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
    const titlesByPath: Record<string, string> = {
      '/': 'Refit: Keep your integrations current',
      '/v1': 'Refit: Keep your integrations current',
      '/v2': 'Refit: Keep your integrations current',
      '/v3': 'Refit: Keep your integrations current',
      '/v4': 'Refit: Keep your integrations current',
      '/demo': 'Refit: Interactive workflow',
      '/docs': 'Refit: Documentation',
    };
    document.title = titlesByPath[pathname] ?? 'Refit: Workspace preview';
  }, [pathname, hash]);
  return null;
}
