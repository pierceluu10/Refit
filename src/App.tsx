import { ArrowLeft } from '@phosphor-icons/react';
import { Link, Route, Routes } from 'react-router-dom';
import { PagePosition } from './components/Layout';
import { Docs } from './pages/Docs';
import { Launch } from './pages/launch/Launch';
import { Workspace } from './pages/Workspace';

export function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <PagePosition />
      <Routes>
        <Route path="/" element={<Launch />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/app/*" element={<Workspace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
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
