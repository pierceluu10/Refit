import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  CaretRight,
  ClockCountdown,
  FolderSimple,
  GithubLogo,
  GitPullRequest,
  List,
  ShieldCheck,
  X,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { Link, matchPath, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Account } from '../components/Account';
import { Brand } from '../components/Brand';
import { WorkspaceMissing } from '../components/WorkspaceUI';
import { PlatformsAndRules } from '../compliance';
import { PROJECT_URL } from '../data';
import { Repositories, RepositoryDetail } from './Repositories';
import { Runs } from './Runs';
import { WhatsBehind } from './WhatsBehind';
import './workspace.css';

const navigation = [
  { path: '/app', name: 'What’s behind', icon: ClockCountdown, exact: true },
  { path: '/app/repos', name: 'Repositories', icon: FolderSimple },
  { path: '/app/runs', name: 'Runs', icon: GitPullRequest },
  { path: '/app/platforms', name: 'Platforms and rules', icon: ShieldCheck },
];

export function Workspace() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const trigger = menuButton.current;
    const drawer = sidebar.current;
    drawer?.querySelector<HTMLButtonElement>('.sidebar-close')?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;
      const controls = Array.from(drawer.querySelectorAll<HTMLElement>('a[href], button'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    const desktop = window.matchMedia('(min-width: 761px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMenuOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    desktop.addEventListener('change', closeOnDesktop);
    return () => {
      document.removeEventListener('keydown', handleKey);
      desktop.removeEventListener('change', closeOnDesktop);
      trigger?.focus();
    };
  }, [menuOpen]);
  useEffect(() => setMenuOpen(false), [location.pathname]);
  const current = navigation.find((item) =>
    matchPath({ path: item.path, end: Boolean(item.exact) }, location.pathname),
  );
  return (
    <div className="workspace">
      <aside
        ref={sidebar}
        role={menuOpen ? 'dialog' : undefined}
        aria-modal={menuOpen || undefined}
        aria-label={menuOpen ? 'Workspace navigation' : undefined}
        className={`app-sidebar ${menuOpen ? 'sidebar-open' : ''}`}
      >
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button sidebar-close"
            aria-label="Close workspace navigation"
            onClick={() => setMenuOpen(false)}
          >
            <X />
          </button>
        </div>
        <nav aria-label="Workspace navigation">
          {navigation.map((item) => (
            <NavLink to={item.path} end={item.exact} key={item.path}>
              <item.icon />
              <span>{item.name}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link to="/docs">
            <BookOpen /> Documentation <ArrowUpRight />
          </Link>
          <a href={PROJECT_URL} target="_blank" rel="noreferrer">
            <GithubLogo /> Source code <ArrowUpRight />
          </a>
          <Link to="/">
            <ArrowLeft /> Back to Refit
          </Link>
        </div>
      </aside>
      {menuOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation backdrop"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <div className="app-main" inert={menuOpen || undefined}>
        <header className="app-topbar">
          <button
            ref={menuButton}
            className="icon-button app-menu"
            onClick={() => setMenuOpen(true)}
            aria-label="Open workspace navigation"
            aria-expanded={menuOpen}
          >
            <List />
          </button>
          <span>
            Dashboard <CaretRight /> <strong>{current?.name ?? 'Not found'}</strong>
          </span>
          <Account />
        </header>
        <main id="main-content" className="app-content">
          <Routes>
            <Route index element={<WhatsBehind />} />
            <Route path="repos" element={<Repositories />} />
            <Route path="repos/:owner/:name" element={<RepositoryDetail />} />
            <Route path="runs" element={<Runs />} />
            <Route path="platforms" element={<PlatformsAndRules />} />
            <Route path="*" element={<WorkspaceMissing />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
