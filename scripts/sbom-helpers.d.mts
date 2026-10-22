// Types for the plain-JavaScript SBOM helpers, so pipeline tests can import them.

export interface SbomComponent {
  'bom-ref': string;
  type: string;
  name: string;
  version: string;
  purl?: string;
  hashes?: { alg: string; content: string }[];
  licenses?: { license: { id: string } }[];
  [key: string]: unknown;
}
export interface Sbom {
  bomFormat: string;
  specVersion: string;
  metadata: { component: SbomComponent; [key: string]: unknown };
  components: SbomComponent[];
  dependencies?: { ref: string; dependsOn?: string[] }[];
  [key: string]: unknown;
}

export function npmPurl(name: string, version: string): string;
export function describeArchive(
  bom: Sbom,
  archive: { name: string; version: string; license?: string; sha256: string },
): Sbom;
export function debianComponents(listing: string, distribution: string): SbomComponent[];
export function npmGlobalComponents(
  listing: { dependencies?: Record<string, { version?: string }> },
  except?: string[],
): SbomComponent[];
export function imageBom(input: {
  image: string;
  imageId: string;
  debian: SbomComponent[];
  node: string;
  oasdiff: string;
  globals: SbomComponent[];
  refit: Sbom;
  timestamp: string;
}): Sbom;
