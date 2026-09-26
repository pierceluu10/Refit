import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, CaretRight, Code, FolderSimple, GithubLogo, GitPullRequest, House, Info, List, MagnifyingGlass, Pulse, SlidersHorizontal, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { CodeDiff } from '../components/Workflow';
import { PROJECT_URL, sampleRepositories } from '../data';
import './workspace.css';
import { PageHeading, Status, WorkspaceMissing } from '../components/WorkspaceUI';
import { Changes, ChangeDetail, Runs, RunDetail } from './Activity';
import { Settings } from './Settings';

const navigation = [
  { path: '/app', name: 'Overview', icon: House, exact: true },
  { path: '/app/repositories', name: 'Repositories', icon: FolderSimple },
  { path: '/app/changes', name: 'API changes', icon: Pulse },
  { path: '/app/runs', name: 'Migration runs', icon: GitPullRequest },
  { path: '/app/settings', name: 'Settings', icon: SlidersHorizontal },
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
      if (event.key === 'Escape') { setMenuOpen(false); return; }
      if (event.key !== 'Tab' || !drawer) return;
      const controls = Array.from(drawer.querySelectorAll<HTMLElement>('a[href], button'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    const desktop = window.matchMedia('(min-width: 761px)');
    const closeOnDesktop = () => { if (desktop.matches) setMenuOpen(false); };
    document.addEventListener('keydown', handleKey);
    desktop.addEventListener('change', closeOnDesktop);
    return () => {
      document.removeEventListener('keydown', handleKey);
      desktop.removeEventListener('change', closeOnDesktop);
      trigger?.focus();
    };
  }, [menuOpen]);
  useEffect(() => setMenuOpen(false), [location.pathname]);
  const current = navigation.find(item => item.exact ? location.pathname === item.path : location.pathname.startsWith(item.path));
  return <div className="workspace"><aside ref={sidebar} role={menuOpen ? "dialog" : undefined} aria-modal={menuOpen || undefined} aria-label={menuOpen ? "Workspace navigation" : undefined} className={`app-sidebar ${menuOpen ? 'sidebar-open' : ''}`}><div className="sidebar-brand"><Brand /><button className="icon-button sidebar-close" aria-label="Close workspace navigation" onClick={() => setMenuOpen(false)}><X /></button></div><div className="workspace-identity"><span className="workspace-avatar">A</span><div><strong>Acme workspace</strong><small>Sample organization</small></div></div><nav aria-label="Workspace navigation">{navigation.map(item => <NavLink to={item.path} end={item.exact} key={item.path}><item.icon /><span>{item.name}</span></NavLink>)}</nav><div className="sidebar-bottom"><Link to="/docs"><BookOpen /> Documentation <ArrowUpRight /></Link><a href={PROJECT_URL} target="_blank" rel="noreferrer"><GithubLogo /> Source code <ArrowUpRight /></a><Link to="/"><ArrowLeft /> Back to Refit</Link></div></aside>{menuOpen && <button className="sidebar-backdrop" aria-label="Close navigation backdrop" onClick={() => setMenuOpen(false)} />}
    <div className="app-main" inert={menuOpen || undefined}><header className="app-topbar"><button ref={menuButton} className="icon-button app-menu" onClick={() => setMenuOpen(true)} aria-label="Open workspace navigation" aria-expanded={menuOpen}><List /></button><span>Workspace <CaretRight /> <strong>{current?.name ?? 'Not found'}</strong></span><span className="preview-chip">Product preview</span></header><main id="main-content" className="app-content"><div className="workspace-notice"><Info /><p>You’re exploring sample data. GitHub is not connected.</p><Link to="/docs#installation">What’s next <ArrowRight /></Link></div><Routes><Route index element={<Overview />} /><Route path="repositories" element={<Repositories />} /><Route path="repositories/:id" element={<RepositoryDetail />} /><Route path="changes" element={<Changes />} /><Route path="changes/:id" element={<ChangeDetail />} /><Route path="runs" element={<Runs />} /><Route path="runs/:id" element={<RunDetail />} /><Route path="settings" element={<Settings />} /><Route path="*" element={<WorkspaceMissing />} /></Routes></main></div></div>;
}

function Overview() {
  return <><PageHeading title="A little change. The full picture." description="An overview of the example workspace and what needs attention." action={<Link className="button button-secondary button-small" to="/demo">Open walkthrough <ArrowUpRight /></Link>} /><div className="overview-summary"><div><span className="summary-number">03</span><span>Sample repositories</span></div><div><span className="summary-number">01</span><span>Illustrated API change</span></div><div><span className="summary-number">02</span><span>Run scenarios to explore</span></div></div><section className="attention-section"><div className="app-section-heading"><h2>Needs a closer look</h2><span>Example impact analysis</span></div><Link className="attention-item" to="/app/repositories/acme-api"><span className="attention-icon"><Code /></span><div><strong>A changed field reaches your billing code</strong><p>acme / api <span>·</span> src/billing/payments.ts</p></div><Status value="Affected" /><CaretRight /></Link><Link className="attention-item" to="/app/repositories/acme-worker"><span className="attention-icon neutral"><MagnifyingGlass /></span><div><strong>One dynamic access needs a human review</strong><p>acme / worker <span>·</span> jobs/reconcile-payments.js</p></div><Status value="Needs review" /><CaretRight /></Link></section><div className="overview-bottom"><section><h2>Your repositories</h2>{sampleRepositories.map(repo => <Link className="compact-repository" key={repo.id} to={`/app/repositories/${repo.id}`}><FolderSimple /><strong>{repo.name}</strong><span>{repo.language}</span><CaretRight /></Link>)}<Link className="text-link" to="/app/repositories">View all repositories <ArrowRight /></Link></section><section className="overview-guide"><GitPullRequest size={27} /><h2>Start at the change.<br />End at the review.</h2><p>Trace the same example through detection, impact analysis, validation, and the draft-PR boundary.</p><Link className="text-link" to="/demo">Take the walkthrough <ArrowRight /></Link></section></div></>;
}

export function Repositories() {
  const [parameters, setParameters] = useSearchParams();
  const search = parameters.get('q') ?? '';
  const requestedStatus = parameters.get('status') ?? 'all';
  const status = ['all', 'Affected', 'Unaffected', 'Needs review'].includes(requestedStatus) ? requestedStatus : 'all';
  const repositories = sampleRepositories.filter(repo => `${repo.name} ${repo.language} ${repo.provider}`.toLowerCase().includes(search.toLowerCase()) && (status === 'all' || status === repo.status));
  function updateParameter(key: string, value: string) {
    const next = new URLSearchParams(parameters);
    if (value && value !== 'all') next.set(key, value); else next.delete(key);
    setParameters(next, { replace: true });
  }
  return <><PageHeading title="Repositories" description="See where a provider change meets your code." action={<Link className="button button-secondary button-small" to="/docs#installation">About connecting GitHub <ArrowUpRight /></Link>} /><div className="resource-toolbar"><label className="search-field"><MagnifyingGlass /><input aria-label="Search repositories" placeholder="Search repositories…" value={search} onChange={event => updateParameter('q', event.target.value)} /></label><label className="filter-field"><span>Status</span><select aria-label="Filter repositories by status" value={status} onChange={event => updateParameter('status', event.target.value)}><option value="all">All statuses</option><option>Affected</option><option>Unaffected</option><option>Needs review</option></select></label></div><div className="resource-table"><div className="resource-table-header"><span>Repository</span><span>Provider</span><span>Impact</span><span /></div>{repositories.map(repo => <Link aria-label={`View ${repo.name}, ${repo.language}, ${repo.status}`} className="resource-row" key={repo.id} to={`/app/repositories/${repo.id}`}><div className="resource-name"><FolderSimple /><div><strong>{repo.name}</strong><small>{repo.language}</small></div></div><span className="provider-label"><span className="provider-mini">S</span>{repo.provider}</span><Status value={repo.status} /><CaretRight /></Link>)}{repositories.length === 0 && <div className="empty-state"><MagnifyingGlass size={30} /><h2>No repositories match.</h2><p>Try a different name or clear the status filter.</p><button className="button button-secondary button-small" onClick={() => setParameters({})}>Clear filters</button></div>}</div><p className="list-footnote">{repositories.length} of {sampleRepositories.length} sample repositories. No live monitoring is active.</p></>;
}

function RepositoryDetail() {
  const { id } = useParams();
  const repo = sampleRepositories.find(item => item.id === id);
  if (!repo) return <WorkspaceMissing />;
  return <><Link className="back-link" to="/app/repositories">← All repositories</Link><PageHeading title={repo.name} description={repo.description} action={<Status value={repo.status} />} /><div className="detail-metadata"><div><span>Language</span><strong>{repo.language}</strong></div><div><span>Provider</span><strong>{repo.provider}</strong></div><div><span>Source</span><strong>Illustrative fixture</strong></div></div><section className="detail-section"><h2>Impact evidence</h2><p>{repo.status === 'Affected' ? 'The example payment wrapper reads the changed charges field. A targeted update handles the latest-charge reference.' : repo.status === 'Unaffected' ? 'The checkout code does not read the changed response property. This example needs no migration.' : 'A dynamic property access cannot be classified confidently. The planned pipeline would retain evidence and request human review.'}</p><div className="detail-file"><Code /><code>{repo.file}</code></div>{repo.status === 'Affected' ? <CodeDiff /> : <div className="detail-explanation"><Info /><span>{repo.status === 'Unaffected' ? 'Unaffected is a result of analysis, not a synonym for “not scanned.”' : 'Uncertainty does not authorize an automatic patch.'}</span></div>}</section><div className="detail-actions"><Link className="button button-primary" to={`/demo?scenario=${repo.status === 'Unaffected' ? 'unaffected' : 'affected'}`}>Explore the scenario <ArrowRight /></Link><Link className="text-link" to="/docs#review">Review policy <ArrowUpRight /></Link></div></>;
}
