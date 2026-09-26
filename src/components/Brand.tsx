import { Link } from 'react-router-dom';

export function Mark({ className = '' }: { className?: string }) {
  return <span className={`refit-mark ${className}`} aria-hidden="true"><span /><span /></span>;
}

export function Brand({ light = false }: { light?: boolean }) {
  return <Link className={`brand ${light ? 'brand-light' : ''}`} to="/" aria-label="Refit home"><Mark /><span>refit</span></Link>;
}
