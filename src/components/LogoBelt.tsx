import { waitlistApis } from '../waitlist';
import { BrandLogo } from './BrandLogo';

// The providers Refit is built for, shown as a belt that drifts left to right. It only shows
// them; nothing in it can be selected.
const providers = waitlistApis.filter((api) => api.id !== 'other');

// The belt scrolls two identical copies so it can loop without a seam. Only the first is
// announced to screen readers.
export function LogoBelt() {
  return (
    <div className="compatible">
      <p id="compatible-title">Compatible with</p>
      <div className="logo-belt">
        <div className="logo-track">
          <BeltCopy />
          <BeltCopy hidden />
        </div>
      </div>
    </div>
  );
}

function BeltCopy({ hidden = false }: { hidden?: boolean }) {
  return (
    <ul
      className="logo-group"
      aria-hidden={hidden || undefined}
      aria-labelledby={hidden ? undefined : 'compatible-title'}
    >
      {providers.map((api) => (
        <li className="logo-chip" key={api.id}>
          <BrandLogo id={api.id} />
          {api.label}
        </li>
      ))}
    </ul>
  );
}
