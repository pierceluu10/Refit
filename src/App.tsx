import { ArrowLeft } from '@phosphor-icons/react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { PagePosition } from './components/Layout';
import { Demo } from './pages/Demo';
import { Docs } from './pages/Docs';
import { Waitlist } from './pages/Waitlist';
import { Workspace } from './pages/Workspace';

export function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <PagePosition />
      <Routes>
        <Route path="/" element={<Waitlist />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/sample/*" element={<Workspace />} />
        <Route path="/app/*" element={<SampleRedirect />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}

// /app was the sample workspace's old address; keep shared links working.
function SampleRedirect() {
  const { '*': rest } = useParams();
  const { search, hash } = useLocation();
  return <Navigate replace to={`/sample${rest ? `/${rest}` : ''}${search}${hash}`} />;
}

function NotFound() {
  return (
    <main id="main-content" className="not-found">
      <p>404</p>
      <h1>This page doesn’t fit.</h1>
      <p>The address may have changed. Head back to Refit to find your way.</p>
      <Link className="button button-primary" to="/">
        <ArrowLeft /> Back to Refit
      </Link>
    </main>
  );
}
