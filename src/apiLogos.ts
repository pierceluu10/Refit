// Each provider's mark as an SVG file in src/logos (sources and licenses in
// src/logos/README.md). Drawn as images, so multi-color and gradient marks
// keep their own colors and ids.
const files = import.meta.glob<string>('./logos/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
});

export const apiLogos: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.slice('./logos/'.length, -'.svg'.length), url]),
);
