const VERIFY_MANAGER = `
import { readFile } from "node:fs/promises";
const { managerVersion, managerIntegrity } = JSON.parse(process.argv[1]);
const root = "/workspace/.refit-tools";
const manifest = JSON.parse(await readFile(root + "/node_modules/pnpm/package.json", "utf8"));
const lock = JSON.parse(await readFile(root + "/package-lock.json", "utf8"));
const integrity = lock.packages["node_modules/pnpm"].integrity;
if (manifest.version !== managerVersion || typeof integrity !== "string" ||
    (managerIntegrity && managerIntegrity !== integrity))
  throw new Error("The installed pnpm manager differs from the declared version or checksum");
console.error("REFIT_PNPM_INTEGRITY=" + integrity);
`;

// The manager is installed without lifecycle scripts; its optional native binary is retained
// with the tool's node_modules so pnpm 11/12 cannot download a launcher during offline checks.
export const PNPM_INSTALL_COMMAND =
  'export COREPACK_ENABLE_NETWORK=0 CI=true PNPM_HOME=/workspace/.pnpm-home ' +
  'XDG_CACHE_HOME=/workspace/.cache XDG_STATE_HOME=/workspace/.state XDG_DATA_HOME=/workspace/.data ' +
  'pnpm_config_pm_on_fail=ignore npm_config_manage_package_manager_versions=false; ' +
  'refit_pnpm_version=$(node -e \'process.stdout.write(JSON.parse(process.argv[1]).managerVersion)\' "$1"); ' +
  'npm install --prefix /workspace/.refit-tools --cache=/workspace/.npm-cache --ignore-scripts --include=optional ' +
  '--engine-strict --no-audit --no-fund --registry=https://registry.npmjs.org "pnpm@$refit_pnpm_version" >&2; ' +
  `node --input-type=module -e '${VERIFY_MANAGER}' "$1"; ` +
  'refit_pnpm=/workspace/.refit-tools/node_modules/.bin/pnpm; ' +
  'printf "REFIT_PNPM_VERSION=" >&2; "$refit_pnpm" --version >&2; ' +
  '"$refit_pnpm" install --frozen-lockfile --ignore-scripts --prod=false ' +
  '--config.ignore-pnpmfile=true --config.enable-global-virtual-store=false --config.engine-strict=true ' +
  '--store-dir=/workspace/.pnpm-store --registry=https://registry.npmjs.org >&2; ' +
  'mkdir -p node_modules; mv /workspace/.refit-tools node_modules/.refit-tools; ';
