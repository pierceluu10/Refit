import { ArrowLeft } from '@phosphor-icons/react';
import { Link, Route, Routes } from 'react-router-dom';
import { PagePosition } from './components/Layout';
import { Demo } from './pages/Demo';
import { Docs } from './pages/Docs';
import { Waitlist } from './pages/Waitlist';
import { WaitlistBlueprint, WaitlistCobalt, WaitlistSplit } from './pages/WaitlistVariants';
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
        <Route path="/v1" element={<WaitlistBlueprint />} />
        <Route path="/v2" element={<WaitlistCobalt />} />
        <Route path="/v3" element={<WaitlistSplit />} />
        <Route path="/demo" element={<Demo />} />
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
