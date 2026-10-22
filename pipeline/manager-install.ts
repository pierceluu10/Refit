// Installs the pinned package-manager tool through npm, so npm verifies its registry integrity,
// and reports the version and integrity it installed.
const VERIFY_MANAGER = `
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const [name, marker, input] = process.argv.slice(1);
const { managerVersion, managerIntegrity, managerBundleSha512 } = JSON.parse(input);
const root = "/workspace/.refit-tools";
const manifest = JSON.parse(await readFile(root + "/node_modules/" + name + "/package.json", "utf8"));
const lock = JSON.parse(await readFile(root + "/package-lock.json", "utf8"));
const integrity = lock.packages["node_modules/" + name].integrity;
const bundle = managerBundleSha512 &&
  createHash("sha512").update(await readFile(root + "/node_modules/" + name + "/bin/yarn.js")).digest("hex");
if (manifest.version !== managerVersion || typeof integrity !== "string" ||
    (managerIntegrity && managerIntegrity !== integrity) || bundle !== managerBundleSha512)
  throw new Error("The installed " + name + " manager differs from the declared version or checksum");
console.error("REFIT_" + marker + "_INTEGRITY=" + integrity);
`;

// `name` is the npm package that ships the manager; its `bin` is called through `$refit_tool`.
function installTool(name: string, bin: string, marker: 'PNPM' | 'YARN' | 'NPM_TOOL') {
  return (
    `refit_tool_version=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).managerVersion)' "$1"); ` +
    'npm install --prefix /workspace/.refit-tools --cache=/workspace/.npm-cache --ignore-scripts --include=optional ' +
    `--engine-strict --no-audit --no-fund --registry=https://registry.npmjs.org "${name}@$refit_tool_version" >&2; ` +
    `node --input-type=module -e '${VERIFY_MANAGER}' ${name} ${marker} "$1"; ` +
    `refit_tool=/workspace/.refit-tools/node_modules/.bin/${bin}; ` +
    `printf "REFIT_${marker}_VERSION=" >&2; "$refit_tool" --version >&2; `
  );
}

// The manager is installed without lifecycle scripts; its optional native binary is retained
// with the tool's node_modules so pnpm 11/12 cannot download a launcher during offline checks.
export const PNPM_INSTALL_COMMAND =
  'export COREPACK_ENABLE_NETWORK=0 CI=true PNPM_HOME=/workspace/.pnpm-home ' +
  'XDG_CACHE_HOME=/workspace/.cache XDG_STATE_HOME=/workspace/.state XDG_DATA_HOME=/workspace/.data ' +
  'pnpm_config_pm_on_fail=ignore npm_config_manage_package_manager_versions=false; ' +
  installTool('pnpm', 'pnpm', 'PNPM') +
  '"$refit_tool" install --frozen-lockfile --ignore-scripts --prod=false ' +
  '--config.ignore-pnpmfile=true --config.enable-global-virtual-store=false --config.engine-strict=true ' +
  '--store-dir=/workspace/.pnpm-store --registry=https://registry.npmjs.org >&2; ' +
  'mkdir -p node_modules; mv /workspace/.refit-tools node_modules/.refit-tools; ';

// Yarn 1 reads rc files from HOME and the project; the installer has no project rc files and a
// private HOME, and --no-default-rc skips the remaining defaults.
export const YARN_INSTALL_COMMAND =
  'export COREPACK_ENABLE_NETWORK=0 CI=true HOME=/workspace/.home YARN_CACHE_FOLDER=/workspace/.yarn-cache; ' +
  installTool('yarn', 'yarn', 'YARN') +
  '"$refit_tool" install --frozen-lockfile --ignore-scripts --non-interactive --production=false ' +
  '--no-default-rc --network-timeout 60000 >&2; ' +
  'mkdir -p node_modules; mv /workspace/.refit-tools node_modules/.refit-tools; ';

// Yarn 2+ is configured only through environment variables: the node-modules linker, no scripts,
// a private cache and an immutable lockfile. Repository rc files never reach the installer.
export const YARN_BERRY_INSTALL_COMMAND =
  'export COREPACK_ENABLE_NETWORK=0 CI=true HOME=/workspace/.home YARN_IGNORE_PATH=1 ' +
  'YARN_NODE_LINKER=node-modules YARN_ENABLE_SCRIPTS=0 YARN_ENABLE_TELEMETRY=0 ' +
  'YARN_ENABLE_GLOBAL_CACHE=0 YARN_CACHE_FOLDER=/workspace/.yarn-cache ' +
  'YARN_NPM_REGISTRY_SERVER=https://registry.npmjs.org YARN_ENABLE_IMMUTABLE_INSTALLS=1; ' +
  installTool('@yarnpkg/cli-dist', 'yarn', 'YARN') +
  '"$refit_tool" install --immutable --mode=skip-build >&2; ' +
  'mkdir -p node_modules; mv /workspace/.refit-tools node_modules/.refit-tools; ';

// A packageManager pin of npm installs that exact npm the same way; npm ci then runs with it, and
// it moves into node_modules so checks run it too. REFIT_NPM_VERSION stays the image's own npm.
export const NPM_TOOL_INSTALL_COMMAND = installTool('npm', 'npm', 'NPM_TOOL');
