// A customer-provided validation image: the repository owner publishes an image that already has
// the repository's dependencies installed, and .refit.json names the node_modules directory inside
// it ("imageNodeModules"). Refit links that directory into the checked-out copy before every check,
// so check commands stay ordinary. Checks still run offline in the same sandbox, with every gate.
// See docs/CUSTOMER-ENVIRONMENT.md.

import { PipelineInputError } from './types.ts';

// An absolute, normalized path ending in node_modules, with no shell metacharacters.
const IMAGE_NODE_MODULES = /^(?:\/[A-Za-z0-9._@+-]+)*\/node_modules$/;

export function validateImageNodeModules(value: unknown) {
  if (
    typeof value !== 'string' ||
    !IMAGE_NODE_MODULES.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')
  )
    throw new PipelineInputError(
      'Run configuration imageNodeModules must be an absolute path inside the image that ends in /node_modules, such as "/opt/app/node_modules".',
    );
  return value;
}

// The check runs in the directory Refit copied the repository into (or its nested package), where
// node_modules must not exist yet: a committed one stops the check rather than being replaced or
// linked into (ln -s into an existing directory would succeed). Exit 125 reads as a check error,
// never as the repository's own check failing.
export const LINK_SCRIPT =
  'if [ -e node_modules ] || [ -L node_modules ]; then echo "Refit: node_modules already exists; imageNodeModules cannot be linked." >&2; exit 125; fi; ln -s "$0" node_modules || exit 125; exec "$@"';

export function linkImageNodeModules(command: string[], imageNodeModules: string | undefined) {
  return imageNodeModules ? ['/bin/sh', '-c', LINK_SCRIPT, imageNodeModules, ...command] : command;
}

// The image holds the original dependencies only, so checks of a patch that changes package files
// (a stripe-node upgrade) would run against the old SDK. Such a patch is recorded untested.
export const IMAGE_PACKAGE_CHANGE = {
  reason: 'customer-image-package-change',
  summary: "the patch changes package files, and the customer image's dependencies are fixed",
  action:
    'Rebuild the validation image from the patched lockfile on the draft branch and run Refit again, or run the checks in your CI on the draft.',
  message:
    'The patch changes package.json or a lockfile; the checks would run against the dependencies the customer image installed from the original lockfile, so they were not run.',
};
