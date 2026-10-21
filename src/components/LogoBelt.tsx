import { Plus } from '@phosphor-icons/react';
import { apiLogos } from '../apiLogos';
import { waitlistApis } from '../waitlist';
import { BrandLogo } from './BrandLogo';

type LogoBeltProps = {
  selected: string[];
  onToggle: (id: string) => void;
};

// The belt scrolls two identical copies so it can loop without a seam. Only
// the first copy is announced and reachable by keyboard; both respond to clicks.
export function LogoBelt({ selected, onToggle }: LogoBeltProps) {
  return (
    <div className="logo-belt">
      <div className="logo-track">
        <BeltCopy selected={selected} onToggle={onToggle} />
        <BeltCopy selected={selected} onToggle={onToggle} hidden />
      </div>
    </div>
  );
}

function BeltCopy({ selected, onToggle, hidden = false }: LogoBeltProps & { hidden?: boolean }) {
  return (
    <div className="logo-group" aria-hidden={hidden || undefined}>
      {waitlistApis.map((api) => (
        <button
          type="button"
          className="logo-chip"
          key={api.id}
          aria-pressed={selected.includes(api.id)}
          tabIndex={hidden ? -1 : undefined}
          onClick={() => onToggle(api.id)}
        >
          {api.id in apiLogos ? (
            <BrandLogo id={api.id} />
          ) : (
            <Plus weight="bold" aria-hidden="true" />
          )}
          {api.label}
        </button>
      ))}
    </div>
  );
}
