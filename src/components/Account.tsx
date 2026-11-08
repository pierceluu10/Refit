import { GithubLogo } from '@phosphor-icons/react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchSession, LOGIN_PATH, logOut, useApi } from '../api';

const DASHBOARD_PATH = '/app';

export function Account() {
  const { state } = useApi(fetchSession, 'session');
  const [searchParams] = useSearchParams();
  const [leaving, setLeaving] = useState(false);
  if (state.status !== 'live') return null;
  const session = state.data;
  if (session.signedIn) {
    const leave = () => {
      setLeaving(true);
      void logOut().then(
        () => window.location.assign(DASHBOARD_PATH),
        () => setLeaving(false),
      );
    };
    return (
      <div className="app-account">
        <strong title={session.orgs.join(', ')}>{session.login}</strong>
        <button className="button button-secondary button-small" onClick={leave} disabled={leaving}>
          Log out
        </button>
      </div>
    );
  }
  if (!session.canSignIn) return null;
  const failed = searchParams.get('login') === 'failed';
  return (
    <div className="app-account">
      {failed && <span role="alert">Sign-in didn’t finish.</span>}
      <a
        className="button button-secondary button-small"
        href={LOGIN_PATH}
        aria-label={failed ? undefined : 'Sign in with GitHub'}
      >
        <GithubLogo />{' '}
        {failed ? (
          'Try again'
        ) : (
          <span>
            Sign in<span className="app-account-provider"> with GitHub</span>
          </span>
        )}
      </a>
    </div>
  );
}
