import { ArrowRight, ArrowUpRight, Info } from '@phosphor-icons/react';
import { Link, useSearchParams } from 'react-router-dom';
import { Footer, Header } from '../components/Layout';
import { Workflow } from '../components/Workflow';
import { scenarios } from '../data';
import type { Scenario } from '../data';

export function Demo() {
  const [parameters, setParameters] = useSearchParams();
  const requested = parameters.get('scenario');
  const scenario: Scenario = requested && Object.hasOwn(scenarios, requested) ? requested as Scenario : 'affected';
  return <><Header /><main id="main-content" className="demo-page content-width"><Link className="back-link" to="/">← Back to Refit</Link><div className="demo-heading"><h1>A change. A patch.<br />The whole picture.</h1><p>Follow a migration from the first signal to the final review.<br />Select a scenario, then explore each step.</p></div><div className="demo-notice"><Info size={18} /><span><strong>Interactive product preview.</strong> These are illustrative scenarios. No repository is accessed, no tests are executed, and no pull request is created.</span></div><div className="scenario-picker" aria-label="Example scenario">{(Object.keys(scenarios) as Scenario[]).map(key => <button key={key} className={scenario === key ? 'selected' : ''} aria-pressed={scenario === key} onClick={() => setParameters({ scenario: key })}>{scenarios[key].label}</button>)}</div><p className="scenario-summary">{scenarios[scenario].summary}</p><Workflow key={scenario} expanded scenario={scenario} /><div className="demo-next"><div><h2>See where the work lives.</h2><p>Browse the repositories, changes, and run details in the sample workspace.</p></div><Link className="button button-dark" to="/app">Explore the workspace <ArrowRight /></Link></div><Link className="text-link" to="/docs#replay">How the real replay pipeline is planned <ArrowUpRight /></Link></main><Footer /></>;
}
