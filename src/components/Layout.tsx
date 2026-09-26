import { ArrowRight, ArrowUpRight, GithubLogo, List, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { PROJECT_URL } from '../data';
import { Brand } from './Brand';

export function Header() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location]);
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
          <NavLink to="/demo">Demo</NavLink>
          <NavLink to="/docs">Docs</NavLink>
          <a className="github-link" href={PROJECT_URL} target="_blank" rel="noreferrer">
            <GithubLogo weight="bold" /> GitHub <ArrowUpRight size={12} />
          </a>
          <Link className="button button-small button-dark" to="/app">
            Explore Refit <ArrowRight />
          </Link>
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
    const titles: Record<string, string> = {
      '/': 'APIs change. Your code keeps up.',
      '/demo': 'Interactive workflow',
      '/docs': 'Documentation',
    };
    document.title = `Refit — ${titles[pathname] ?? 'Workspace preview'}`;
  }, [pathname, hash]);
  return null;
}
