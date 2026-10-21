import { apiLogos } from '../apiLogos';

// Draws a provider's mark in its own colors. Decorative: the provider's name
// is always written next to it.
export function BrandLogo({ id }: { id: string }) {
  const url = apiLogos[id];
  if (!url) return null;
  return <img className="brand-logo" src={url} alt="" draggable={false} />;
}
