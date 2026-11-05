import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CaretRight,
  ClockCounterClockwise,
  FolderSimple,
  GithubLogo,
  GitPullRequest,
  House,
  Info,
  List,
  MagnifyingGlass,
  Plugs,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { Brand } from '../components/Brand';
import { PROJECT_URL } from '../data';
import {
  organization,
  providerName,
  providersOf,
  repositories,
  resultOf,
  tasks,
  usages,
} from '../fixtures';
import './workspace.css';
import { CallSites, PageHeading, Status, WorkspaceMissing } from '../components/WorkspaceUI';
import { Runs } from './Runs';
import { TaskDetail, TaskList, Tasks } from './Tasks';
import type { ApiUsage } from '../../shared/types.ts';

const navigation = [
  { path: '/app', name: 'Overview', icon: House, exact: true },
  { path: '/app/repositories', name: 'Repositories', icon: FolderSimple },
  { path: '/app/tasks', name: 'Tasks', icon: GitPullRequest },
  { path: '/app/runs', name: 'Runs', icon: ClockCounterClockwise },
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
    item.exact ? location.pathname === item.path : location.pathname.startsWith(item.path),
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
        <div className="workspace-identity">
          <span className="workspace-avatar">E</span>
          <div>
            <strong>{organization.name}</strong>
            <small>Example organization</small>
          </div>
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
          <span className="preview-chip">In development</span>
        </header>
        <main id="main-content" className="app-content">
          <div className="workspace-notice">
            <Info />
            <p>This dashboard shows example data. GitHub isn’t connected yet.</p>
            <Link to="/docs#installation">
              What’s next <ArrowRight />
            </Link>
          </div>
          <Routes>
            <Route index element={<Overview />} />
            <Route path="repositories" element={<Repositories />} />
            <Route path="repositories/:id" element={<RepositoryDetail />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="tasks/:id" element={<TaskDetail />} />
            <Route path="runs" element={<Runs />} />
            <Route path="*" element={<WorkspaceMissing />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

const viaLabels: Record<ApiUsage['via'], string> = {
  sdk: 'SDK',
  http: 'Raw HTTP',
  graphql: 'GraphQL',
  webhook: 'Webhook',
};
const providers = [...new Set(usages.map((usage) => usage.provider))];

function tasksOf(repo: string) {
  return tasks.filter((task) => task.repo === repo);
}

function Overview() {
  const openPullRequests = tasks.filter((task) => resultOf(task.id)?.pr);
  const needsReview = tasks.filter((task) => resultOf(task.id)?.outcome === 'needs-review');
  return (
    <>
      <PageHeading
        title={organization.name}
        description="Every external API your repositories use, and the work it creates."
        action={
          <Link className="button button-secondary button-small" to="/demo">
            Open walkthrough <ArrowUpRight />
          </Link>
        }
      />
      <div className="overview-summary">
        <div>
          <span className="summary-number">{repositories.length}</span>
          <span>Repositories</span>
        </div>
        <div>
          <span className="summary-number">{providers.length}</span>
          <span>APIs in use</span>
        </div>
        <div>
          <span className="summary-number">{openPullRequests.length}</span>
          <span>Open pull requests</span>
        </div>
      </div>
      <section className="attention-section">
        <div className="app-section-heading">
          <h2>Pull requests that need review</h2>
          <span>
            {needsReview.length} of {tasks.length} tasks
          </span>
        </div>
        {needsReview.map((task) => (
          <Link className="attention-item" key={task.id} to={`/app/tasks/${task.id}`}>
            <span className="attention-icon">
              <WarningCircle />
            </span>
            <div>
              <strong>{task.change.title}</strong>
              <p>
                {task.repo} <span>·</span> {providerName(task.change.provider)}
              </p>
            </div>
            <Status outcome="needs-review" />
            <CaretRight />
          </Link>
        ))}
      </section>
      <div className="overview-bottom">
        <section>
          <h2>APIs in use</h2>
          {providers.map((provider) => {
            const providerUsages = usages.filter((usage) => usage.provider === provider);
            const repoCount = new Set(providerUsages.map((usage) => usage.repo)).size;
            return (
              <div className="compact-repository" key={provider}>
                <Plugs />
                <strong>{providerName(provider)}</strong>
                <span>
                  {[...new Set(providerUsages.map((usage) => viaLabels[usage.via]))].join(', ')} ·{' '}
                  {repoCount} {repoCount === 1 ? 'repository' : 'repositories'}
                </span>
              </div>
            );
          })}
          <Link className="text-link" to="/app/tasks">
            View all tasks <ArrowRight />
          </Link>
        </section>
        <section>
          <h2>Repositories</h2>
          {repositories.map((repo) => (
            <Link className="compact-repository" key={repo.id} to={`/app/repositories/${repo.id}`}>
              <FolderSimple />
              <strong>{repo.name}</strong>
              <span>{repo.language}</span>
              <CaretRight />
            </Link>
          ))}
          <Link className="text-link" to="/app/repositories">
            View all repositories <ArrowRight />
          </Link>
        </section>
      </div>
    </>
  );
}

function Repositories() {
  const [parameters, setParameters] = useSearchParams();
  const search = parameters.get('q') ?? '';
  const requestedProvider = parameters.get('provider') ?? 'all';
  const provider = providers.includes(requestedProvider) ? requestedProvider : 'all';
  const matches = repositories.filter(
    (repo) =>
      `${repo.name} ${repo.language} ${providersOf(repo.name).map(providerName).join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (provider === 'all' || providersOf(repo.name).includes(provider)),
  );
  function updateParameter(key: string, value: string) {
    const next = new URLSearchParams(parameters);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParameters(next, { replace: true });
  }
  return (
    <>
      <PageHeading
        title="Repositories"
        description="What each repository calls, and through what."
        action={
          <Link className="button button-secondary button-small" to="/docs#installation">
            About connecting GitHub <ArrowUpRight />
          </Link>
        }
      />
      <div className="resource-toolbar">
        <label className="search-field">
          <MagnifyingGlass />
          <input
            aria-label="Search repositories"
            placeholder="Search repositories…"
            value={search}
            onChange={(event) => updateParameter('q', event.target.value)}
          />
        </label>
        <label className="filter-field">
          <span>API</span>
          <select
            aria-label="Filter repositories by API"
            value={provider}
            onChange={(event) => updateParameter('provider', event.target.value)}
          >
            <option value="all">All APIs</option>
            {providers.map((item) => (
              <option key={item} value={item}>
                {providerName(item)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="resource-table">
        <div className="resource-table-header">
          <span>Repository</span>
          <span>APIs</span>
          <span>Tasks</span>
          <span />
        </div>
        {matches.map((repo) => {
          const taskCount = tasksOf(repo.name).length;
          return (
            <Link
              aria-label={`View ${repo.name}, ${repo.language}, ${taskCount} tasks`}
              className="resource-row"
              key={repo.id}
              to={`/app/repositories/${repo.id}`}
            >
              <div className="resource-name">
                <FolderSimple />
                <div>
                  <strong>{repo.name}</strong>
                  <small>{repo.language}</small>
                </div>
              </div>
              <span className="provider-chips">
                {providersOf(repo.name).map((item) => (
                  <span key={item}>{providerName(item)}</span>
                ))}
              </span>
              <span className="task-count">
                {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
              </span>
              <CaretRight />
            </Link>
          );
        })}
        {matches.length === 0 && (
          <div className="empty-state">
            <MagnifyingGlass size={30} />
            <h2>No repositories match.</h2>
            <p>Try a different name or clear the API filter.</p>
            <button
              className="button button-secondary button-small"
              onClick={() => setParameters({})}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
      <p className="list-footnote">
        {matches.length} of {repositories.length} example repositories. Nothing is being monitored.
      </p>
    </>
  );
}

function RepositoryDetail() {
  const { id } = useParams();
  const repo = repositories.find((item) => item.id === id);
  if (!repo) return <WorkspaceMissing />;
  const repoUsages = usages.filter((usage) => usage.repo === repo.name);
  const repoTasks = tasksOf(repo.name);
  return (
    <>
      <Link className="back-link" to="/app/repositories">
        ← All repositories
      </Link>
      <PageHeading title={repo.name} description={repo.description} />
      <div className="detail-metadata">
        <div>
          <span>Language</span>
          <strong>{repo.language}</strong>
        </div>
        <div>
          <span>APIs</span>
          <strong>{providersOf(repo.name).map(providerName).join(', ')}</strong>
        </div>
        <div>
          <span>Tasks</span>
          <strong>{repoTasks.length}</strong>
        </div>
      </div>
      <section className="detail-section">
        <h2>APIs in use</h2>
        <p>What an agent found reading this repository: each API, how it’s called, and where.</p>
        {repoUsages.map((usage) => (
          <article className="api-usage" key={`${usage.provider}-${usage.via}`}>
            <header>
              <h3>{providerName(usage.provider)}</h3>
              <span>{viaLabels[usage.via]}</span>
            </header>
            {(usage.sdk || usage.pinnedVersion) && (
              <dl>
                {usage.sdk && (
                  <div>
                    <dt>SDK</dt>
                    <dd>
                      <code>
                        {usage.sdk.name} {usage.sdk.version}
                      </code>
                      {usage.sdk.lockfile && <> in {usage.sdk.lockfile}</>}
                    </dd>
                  </div>
                )}
                {usage.pinnedVersion && (
                  <div>
                    <dt>Pinned version</dt>
                    <dd>
                      <code>{usage.pinnedVersion.value}</code> at{' '}
                      <code>
                        {usage.pinnedVersion.file}:{usage.pinnedVersion.line}
                      </code>
                    </dd>
                  </div>
                )}
              </dl>
            )}
            <CallSites callSites={usage.callSites} />
          </article>
        ))}
      </section>
      <section className="detail-section">
        <h2>Tasks</h2>
        {repoTasks.length > 0 ? (
          <TaskList items={repoTasks} />
        ) : (
          <div className="detail-explanation">
            <Info />
            <span>No provider change touches this repository’s call sites.</span>
          </div>
        )}
      </section>
      <section className="detail-section">
        <h2>Runs</h2>
        <p>What the agent did on each task, what it cost and the pull request it opened.</p>
        <Link className="text-link" to={`/app/runs?repo=${encodeURIComponent(repo.name)}`}>
          View runs for {repo.name} <ArrowRight />
        </Link>
      </section>
    </>
  );
}
