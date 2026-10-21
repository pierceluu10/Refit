import { useId } from 'react';
import { apiLogos } from '../apiLogos';

// Draws a provider's mark in its own colors: one path in the brand color, a
// gradient-filled path, or several colored parts.
export function BrandLogo({ id }: { id: string }) {
  const gradientId = useId();
  const logo = apiLogos[id];
  if (!logo) return null;
  return (
    <svg viewBox={logo.viewBox ?? '0 0 24 24'} aria-hidden="true">
      {logo.gradient && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            {logo.gradient.map((color, index) => (
              <stop
                key={color}
                offset={`${(index / (logo.gradient!.length - 1)) * 100}%`}
                stopColor={color}
              />
            ))}
          </linearGradient>
        </defs>
      )}
      {logo.parts?.map((part) => (
        <path key={part.fill} d={part.d} fill={part.fill} />
      ))}
      {logo.path && (
        <path d={logo.path} fill={logo.gradient ? `url(#${gradientId})` : logo.color} />
      )}
    </svg>
  );
}
