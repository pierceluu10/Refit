import { Link, Navigate, useParams } from 'react-router-dom';
import { Header } from '../../components/Layout';
import { ParticleField } from '../../components/ParticleField';
import { LaunchClose, LaunchHero, LaunchSteps } from '../Waitlist';
import { DiffHero, HorizonHero } from './Heroes';
import { PlaygroundSection } from './Playground';
import { StackSection } from './Stack';
import { VersusSection } from './Versus';
import './mockups.css';

const heroes = {
  current: { label: 'Current', Hero: LaunchHero },
  horizon: { label: 'Horizon', Hero: HorizonHero },
  diff: { label: 'Diff', Hero: DiffHero },
};
const sections = {
  current: { label: 'Current', Section: LaunchSteps },
  versus: { label: 'Versus', Section: VersusSection },
  playground: { label: 'Playground', Section: PlaygroundSection },
  stack: { label: 'Stack', Section: StackSection },
};
const DEFAULT_PATH = '/mockups/horizon/versus';

// Drafts of the homepage's first two screens, mixed and matched from the switcher at the bottom.
// The closing band is the live one.
export function Mockups() {
  const { hero = '', section = '' } = useParams();
  if (!(hero in heroes) || !(section in sections)) return <Navigate replace to={DEFAULT_PATH} />;
  const { Hero } = heroes[hero as keyof typeof heroes];
  const { Section } = sections[section as keyof typeof sections];

  return (
    <div className="waitlist-theme launch">
      <meta name="robots" content="noindex" />
      <ParticleField />
      <div className="launch-top">
        <Header minimal />
        <main id="main-content">
          <Hero key={hero} />
        </main>
      </div>
      <Section key={section} />
      <LaunchClose />
      <nav className="mock-switcher" aria-label="Mockup variants">
        <Picker
          label="Hero"
          options={heroes}
          current={hero}
          path={(id) => `/mockups/${id}/${section}`}
        />
        <Picker
          label="Second"
          options={sections}
          current={section}
          path={(id) => `/mockups/${hero}/${id}`}
        />
      </nav>
    </div>
  );
}

function Picker({
  label,
  options,
  current,
  path,
}: {
  label: string;
  options: Record<string, { label: string }>;
  current: string;
  path: (id: string) => string;
}) {
  return (
    <div className="mock-picker">
      <span>{label}</span>
      {Object.entries(options).map(([id, option]) => (
        <Link key={id} to={path(id)} aria-current={id === current ? 'page' : undefined}>
          {option.label}
        </Link>
      ))}
    </div>
  );
}
