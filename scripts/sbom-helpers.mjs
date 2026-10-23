// Turns npm's and Debian's own package listings into CycloneDX 1.5 components, so the SBOM script
// needs no dependency beyond npm, tar and Docker.
import { randomUUID } from 'node:crypto';

export function npmPurl(name, version) {
  return `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
}

// Names the root after the packed package and records the archive digest. `npm sbom` run in an
// unpacked tarball otherwise names the root after the `package/` folder.
export function describeArchive(bom, { name, version, license, sha256 }) {
  const component = {
    ...bom.metadata.component,
    'bom-ref': `${name}@${version}`,
    name,
    version,
    purl: npmPurl(name, version),
    hashes: [{ alg: 'SHA-256', content: sha256 }],
    ...(license ? { licenses: [{ license: { id: license } }] } : {}),
  };
  const previous = bom.metadata.component?.['bom-ref'];
  return {
    ...bom,
    metadata: { ...bom.metadata, component },
    dependencies: (bom.dependencies ?? []).map((entry) =>
      entry.ref === previous ? { ...entry, ref: component['bom-ref'] } : entry,
    ),
  };
}

// Parses `dpkg-query -W -f '${Package}\t${Version}\t${Architecture}\n'`.
export function debianComponents(listing, distribution) {
  return listing
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name, version, architecture] = line.split('\t');
      if (!name || !version || !architecture)
        throw new Error(`Unexpected dpkg-query line: ${JSON.stringify(line)}`);
      const purl = `pkg:deb/${distribution}/${name}@${encodeURIComponent(version)}?arch=${architecture}`;
      return { 'bom-ref': purl, type: 'library', name, version, purl };
    });
}

// Parses `npm ls --global --depth=0 --json`.
export function npmGlobalComponents(listing, except = []) {
  return Object.entries(listing.dependencies ?? {})
    .filter(([name]) => !except.includes(name))
    .map(([name, entry]) => {
      if (typeof entry.version !== 'string')
        throw new Error(`Global npm package ${name} has no version.`);
      const purl = npmPurl(name, entry.version);
      return { 'bom-ref': purl, type: 'application', name, version: entry.version, purl };
    });
}

// One SBOM for the hosted image: Debian packages, Node.js, oasdiff, global npm tools, and the
// installed Refit CLI with its locked runtime tree from its own `npm sbom`.
export function imageBom({ image, imageId, debian, node, oasdiff, globals, refit, timestamp }) {
  const installed = [
    ...debian,
    {
      'bom-ref': `pkg:generic/node@${node}`,
      type: 'application',
      name: 'node',
      version: node,
      purl: `pkg:generic/node@${node}`,
    },
    {
      'bom-ref': `pkg:golang/github.com/oasdiff/oasdiff@v${oasdiff}`,
      type: 'application',
      name: 'oasdiff',
      version: oasdiff,
      purl: `pkg:golang/github.com/oasdiff/oasdiff@v${oasdiff}`,
    },
    ...globals,
    { ...refit.metadata.component, type: 'application' },
  ];
  const components = [...installed, ...refit.components];
  const references = new Set();
  for (const component of components) {
    if (references.has(component['bom-ref']))
      throw new Error(`Duplicate SBOM component ${component['bom-ref']}.`);
    references.add(component['bom-ref']);
  }
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [{ name: 'refit scripts/sbom.mjs' }],
      component: { 'bom-ref': image, type: 'container', name: image, version: imageId },
    },
    components,
    dependencies: [
      { ref: image, dependsOn: installed.map((component) => component['bom-ref']) },
      ...(refit.dependencies ?? []),
    ],
  };
}
