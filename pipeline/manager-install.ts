// Installs the pinned package-manager tool through npm, so npm verifies its registry integrity,
// and reports the version and integrity it installed.
const VERIFY_MANAGER = `
import { readFile } from "node:fs/promises";
const [tool, input] = process.argv.slice(1);
const { managerVersion, managerIntegrity } = JSON.parse(input);
const root = "/workspace/.refit-tools";
const manifest = JSON.parse(await readFile(root + "/node_modules/" + tool + "/package.json", "utf8"));
const lock = JSON.parse(await readFile(root + "/package-lock.json", "utf8"));
const integrity = lock.packages["node_modules/" + tool].integrity;
if (manifest.version !== managerVersion || typeof integrity !== "string" ||
    (managerIntegrity && managerIntegrity !== integrity))
  throw new Error("The installed " + tool + " manager differs from the declared version or checksum");
console.error("REFIT_" + tool.toUpperCase() + "_INTEGRITY=" + integrity);
`;

function installTool(tool: 'pnpm' | 'yarn') {
  return (
    `refit_tool_version=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).managerVersion)' "$1"); ` +
    'npm install --prefix /workspace/.refit-tools --cache=/workspace/.npm-cache --ignore-scripts --include=optional ' +
    `--engine-strict --no-audit --no-fund --registry=https://registry.npmjs.org "${tool}@$refit_tool_version" >&2; ` +
    `node --input-type=module -e '${VERIFY_MANAGER}' ${tool} "$1"; ` +
    `refit_tool=/workspace/.refit-tools/node_modules/.bin/${tool}; ` +
    `printf "REFIT_${tool.toUpperCase()}_VERSION=" >&2; "$refit_tool" --version >&2; `
  );
}

// The manager is installed without lifecycle scripts; its optional native binary is retained
// with the tool's node_modules so pnpm 11/12 cannot download a launcher during offline checks.
export const PNPM_INSTALL_COMMAND =
  'export COREPACK_ENABLE_NETWORK=0 CI=true PNPM_HOME=/workspace/.pnpm-home ' +
  'XDG_CACHE_HOME=/workspace/.cache XDG_STATE_HOME=/workspace/.state XDG_DATA_HOME=/workspace/.data ' +
  'pnpm_config_pm_on_fail=ignore npm_config_manage_package_manager_versions=false; ' +
  installTool('pnpm') +
  '"$refit_tool" install --frozen-lockfile --ignore-scripts --prod=false ' +
  '--config.ignore-pnpmfile=true --config.enable-global-virtual-store=false --config.engine-strict=true ' +
  '--store-dir=/workspace/.pnpm-store --registry=https://registry.npmjs.org >&2; ' +
  'mkdir -p node_modules; mv /workspace/.refit-tools node_modules/.refit-tools; ';

// Yarn 1 reads rc files from HOME and the project; the installer has no project rc files and a
// private HOME, and --no-default-rc skips the remaining defaults.
export const YARN_INSTALL_COMMAND =
  'export COREPACK_ENABLE_NETWORK=0 CI=true HOME=/workspace/.home YARN_CACHE_FOLDER=/workspace/.yarn-cache; ' +
  installTool('yarn') +
  '"$refit_tool" install --frozen-lockfile --ignore-scripts --non-interactive --production=false ' +
  '--no-default-rc --network-timeout 60000 >&2; ' +
  'mkdir -p node_modules; mv /workspace/.refit-tools node_modules/.refit-tools; ';
