import { ArrowUpRight, DownloadSimple, Info, LockSimple } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CopyButton } from '../components/CopyButton';
import { PageHeading } from '../components/WorkspaceUI';
import {
  createConfiguration,
  MAX_REPAIR_ATTEMPTS,
  MIN_REPAIR_ATTEMPTS,
  packageManagers,
  validationChecks,
} from '../configuration';
import type { PackageManager, ValidationCheck } from '../configuration';

export function Settings() {
  const [manager, setManager] = useState<PackageManager>('npm');
  const [checks, setChecks] = useState<ValidationCheck[]>([...validationChecks]);
  const [attempts, setAttempts] = useState(MAX_REPAIR_ATTEMPTS);
  const [error, setError] = useState('');
  const config = createConfiguration(manager, checks, attempts);

  function toggleCheck(check: ValidationCheck) {
    if (checks.includes(check) && checks.length === 1) {
      setError('Keep at least one validation check. A migration must be validated.');
      return;
    }
    setChecks((current) =>
      current.includes(check) ? current.filter((item) => item !== check) : [...current, check],
    );
    setError('');
  }

  return (
    <>
      <PageHeading
        title="Your workflow, in a file."
        description="Build an example refit.yml for your repository. Nothing is applied remotely."
      />
      <div className="settings-layout">
        <div className="settings-form">
          <section>
            <h2>Repository access</h2>
            <div className="connection-state">
              <span className="connection-dot" />
              <div>
                <strong>GitHub is not connected</strong>
                <p>This preview does not request access to your repositories.</p>
              </div>
            </div>
            <Link className="text-link" to="/docs#installation">
              Read the planned installation flow <ArrowUpRight />
            </Link>
          </section>
          <section>
            <h2>Validation</h2>
            <label className="setting-label" htmlFor="package-manager">
              Package manager
            </label>
            <select
              id="package-manager"
              value={manager}
              onChange={(event) => setManager(event.target.value as PackageManager)}
            >
              {Object.keys(packageManagers).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <fieldset>
              <legend>Required checks</legend>
              {validationChecks.map((check) => (
                <label className="check-option" key={check}>
                  <input
                    type="checkbox"
                    checked={checks.includes(check)}
                    onChange={() => toggleCheck(check)}
                  />
                  <span>
                    {check === 'typecheck' ? 'Typecheck' : check === 'lint' ? 'Lint' : 'Tests'}
                  </span>
                  <code>
                    {check === 'test'
                      ? packageManagers[manager].test
                      : `${packageManagers[manager].run} ${check}`}
                  </code>
                </label>
              ))}
            </fieldset>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <label className="setting-label" htmlFor="repair-attempts">
              Maximum repair attempts
            </label>
            <select
              id="repair-attempts"
              value={attempts}
              onChange={(event) => setAttempts(Number(event.target.value))}
            >
              {Array.from(
                { length: MAX_REPAIR_ATTEMPTS - MIN_REPAIR_ATTEMPTS + 1 },
                (_, index) => index + MIN_REPAIR_ATTEMPTS,
              ).map((value) => (
                <option key={value} value={value}>
                  {value} {value === 1 ? 'attempt' : 'attempts'}
                </option>
              ))}
            </select>
            <p className="setting-help">
              Stop after this limit. Failed required checks block publication.
            </p>
          </section>
          <section className="locked-setting">
            <LockSimple />
            <div>
              <h2>Draft pull requests only</h2>
              <p>Human review is always required. Automatic merging is outside the MVP scope.</p>
            </div>
          </section>
        </div>
        <div className="settings-output">
          <div className="docs-code">
            <div>
              <span>refit.yml</span>
              <CopyButton text={config} />
            </div>
            <pre aria-label="Generated repository configuration">
              <code>{config}</code>
            </pre>
          </div>
          <a
            className="button button-dark"
            href={`data:text/yaml;charset=utf-8,${encodeURIComponent(config)}`}
            download="refit.yml"
          >
            <DownloadSimple /> Download refit.yml
          </a>
          <div className="setting-export-note">
            <Info />
            <p>
              This file is a starting point. Match the commands to your repository. The connected
              pipeline is not available yet.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
