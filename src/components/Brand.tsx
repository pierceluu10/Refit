import { Link } from 'react-router-dom';

// The two brackets from public/favicon.svg, inside its 40-unit square.
export const MARK_PATH = 'M10 11h15v6H16v6h-6zm20 18H15v-6h9v-6h6z';
// The brackets' own box within that square.
export const MARK_BOX = { x: 10, y: 11, width: 20, height: 18 };

export function Mark({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`refit-mark ${className}`}
      viewBox={`${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`}
      aria-hidden="true"
    >
      <path d={MARK_PATH} fill="currentColor" />
    </svg>
  );
}

// The favicon itself, a blue tile with the white brackets, beside the name.
export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="Refit home">
      <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
        <rect width="40" height="40" rx="10" fill="currentColor" />
        <path d={MARK_PATH} fill="#fff" />
      </svg>
      <span>Refit</span>
    </Link>
  );
}
