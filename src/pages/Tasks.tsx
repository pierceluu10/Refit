import { CaretRight, GitPullRequest, Info, ShieldCheck } from '@phosphor-icons/react';
import { Link, useParams } from 'react-router-dom';
import type { MigrationTask } from '../../shared/types.ts';
import { CallSites, PageHeading, Status, WorkspaceMissing } from '../components/WorkspaceUI';
import { providerName, repositories, resultOf, tasks } from '../fixtures';

const rankedTasks = [...tasks].sort((a, b) => a.priority - b.priority);

function repositoryOf(task: MigrationTask) {
  return repositories.find((repo) => repo.name === task.repo);
}

export function TaskList({ items }: { items: MigrationTask[] }) {
  return (
    <div className="task-list">
      {items.map((task) => {
        const result = resultOf(task.id);
        return (
          <Link key={task.id} to={`/app/tasks/${task.id}`}>
            <GitPullRequest />
            <div>
              <strong>{task.change.title}</strong>
              <p>
                P{task.priority} <span>·</span> {task.repo} <span>·</span>{' '}
                {task.deadline ? `Due ${task.deadline}` : 'No deadline'}
              </p>
            </div>
            {result && <Status outcome={result.outcome} />}
            <CaretRight />
          </Link>
        );
      })}
    </div>
  );
}

export function Tasks() {
  return (
    <>
      <PageHeading
        title="Migration tasks"
        description="Provider changes matched to your call sites, most urgent first."
      />
      <TaskList items={rankedTasks} />
      <p className="list-footnote">
        Each task ends in a pull request marked verified or needs-review, or a not-affected verdict.
      </p>
    </>
  );
}

export function TaskDetail() {
  const { id } = useParams();
  const task = tasks.find((item) => item.id === id);
  const result = task && resultOf(task.id);
  if (!task || !result) return <WorkspaceMissing />;
  const { change } = task;
  const repo = repositoryOf(task);
  return (
    <>
      <Link className="back-link" to="/app/tasks">
        ← All tasks
      </Link>
      <PageHeading
        title={change.title}
        description={`${providerName(change.provider)} · ${change.kind.replaceAll('-', ' ')}`}
        action={<Status outcome={result.outcome} />}
      />
      <div className="detail-metadata">
        <div>
          <span>Repository</span>
          <strong>
            {repo ? <Link to={`/app/repositories/${repo.id}`}>{task.repo}</Link> : task.repo}
          </strong>
        </div>
        <div>
          <span>Priority</span>
          <strong>P{task.priority}</strong>
        </div>
        <div>
          <span>Deadline</span>
          <strong>{task.deadline ?? 'None given'}</strong>
        </div>
      </div>
      <section className="detail-section">
        <h2>What changed</h2>
        <p>
          {change.effectiveDate
            ? `Takes effect on ${change.effectiveDate}.`
            : 'The source gives no effective date.'}
        </p>
        <figure className="change-quote">
          <blockquote>{change.source.quote}</blockquote>
          <figcaption>
            Illustrative quote <span>·</span> <code>{change.source.url}</code>
          </figcaption>
        </figure>
      </section>
      <section className="detail-section">
        <h2>Affected call sites</h2>
        <CallSites callSites={task.usages.flatMap((usage) => usage.callSites)} />
      </section>
      <section className="detail-section">
        <h2>{result.outcome === 'not-affected' ? 'Verdict' : 'Pull request'}</h2>
        <p>{result.summary}</p>
        {result.pr && (
          <div className="detail-file">
            <GitPullRequest />
            <code>{result.pr}</code>
          </div>
        )}
        {result.checks.length > 0 && (
          <div className="proof-table">
            <table>
              <caption>Checks before and after the change</caption>
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {result.checks.map((check) => (
                  <tr key={check.name}>
                    <th scope="row">{check.name}</th>
                    <td>{check.before}</td>
                    <td>{check.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.unproven.length > 0 ? (
          <div className="unproven">
            <h3>What’s unproven</h3>
            <ul>
              {result.unproven.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="detail-explanation">
            {result.outcome === 'verified' ? <ShieldCheck /> : <Info />}
            <span>
              {result.outcome === 'verified'
                ? 'Every check passed before and after. A person still reviews and merges the pull request.'
                : 'No pull request. The verdict and its reasoning stay on the task.'}
            </span>
          </div>
        )}
      </section>
    </>
  );
}
