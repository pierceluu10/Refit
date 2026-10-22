import type { Repository } from './types.ts';

// Report-only detection of models called through a cloud host rather than the provider's own API:
// Amazon Bedrock model IDs and ARNs, Azure OpenAI deployments and `api-version`s, and OpenRouter
// model IDs. Nothing is edited. A site whose date Refit cannot know from the registry carries a
// named stop saying what to check, so it is never mistaken for a safe result or an edit target.

export type ModelHost = 'bedrock' | 'azure-openai' | 'openrouter';

export type ModelHostStop =
  // An Azure deployment name is chosen by the customer; the model behind it is set in Azure.
  | 'azure-deployment-name'
  // No registry entry gives this host's date for the model or version (yet).
  | 'bedrock-lifecycle-unknown'
  | 'azure-api-version-lifecycle-unknown'
  // An OpenRouter alias (`anthropic/claude-3.5-sonnet`) that names no single dated upstream model.
  | 'openrouter-alias';

export interface ModelHostSite {
  host: ModelHost;
  file: string;
  line: number;
  column: number;
  kind: 'model-id' | 'deployment' | 'api-version';
  value: string;
  // The provider's own model ID this host ID stands for, when it does so exactly.
  upstream: { provider: string; model: string } | null;
  stop: ModelHostStop | null;
  text: string;
}

// Bedrock foundation-model and cross-region inference-profile IDs end in a version suffix
// (`-v1:0`, `-v2`, `:0`), which keeps hostnames such as `amazon.com` out.
const BEDROCK_PROVIDERS =
  'anthropic|amazon|meta|mistral|cohere|ai21|deepseek|openai|qwen|writer|stability|twelvelabs|luma|moonshot|minimax|google|nvidia';
const BEDROCK_ID = new RegExp(
  `^(?:(?:us|eu|apac|global|us-gov|ca|jp|au|ap)\\.)?(?:${BEDROCK_PROVIDERS})\\.[a-z0-9][a-z0-9.]*-[a-z0-9.-]*?(?:-v\\d+(?::\\d+)?|:\\d+)(?::\\d+k)?$`,
);
const BEDROCK_ARN =
  /^arn:aws(?:-[a-z]+)?:bedrock:[a-z0-9-]*:\d*:(?:foundation-model|inference-profile|application-inference-profile|provisioned-model)\/(.+)$/;
// Newer Bedrock IDs drop the version suffix (`us.anthropic.claude-haiku-5-5` in AWS's own
// examples); they count only in a file that uses a Bedrock SDK or names Bedrock in its path or text.
const BEDROCK_UNVERSIONED = new RegExp(
  `^(?:(?:us|eu|apac|global|us-gov|ca|jp|au|ap)\\.)?(?:${BEDROCK_PROVIDERS})\\.[a-z0-9][a-z0-9.]*-[a-z0-9.-]*[a-z0-9]$`,
);
const BEDROCK_ANTHROPIC = /^(?:[a-z-]{2,6}\.)?anthropic\.(claude-[a-z0-9.-]+?)(?:-v\d+(?::\d+)?)?$/;
const BEDROCK_CONTEXT =
  /['"](?:@aws-sdk\/client-bedrock-runtime|@aws-sdk\/client-bedrock|@anthropic-ai\/bedrock-sdk|@ai-sdk\/amazon-bedrock|@langchain\/aws)['"]|(?<!:)bedrock/i;

// A file that sets up Azure OpenAI. Azure's v1 endpoint uses the plain OpenAI client, so its
// endpoint or settings mark the file too. Only here does a request's `model` count as a deployment.
const AZURE_CLIENT =
  /\bAzureOpenAI\b|['"]@azure\/openai['"]|\.openai\.azure\.com|\.cognitiveservices\.azure\.com|\bAZURE_OPENAI_\w+/;
// Any mention of Azure: enough for keys that say `deployment` themselves and for api-versions.
const AZURE_CONTEXT = /azure/i;
const AZURE_API_VERSION = '\\d{4}-\\d{2}-\\d{2}(?:-preview)?';
const DEPLOYMENT_KEY = '[A-Za-z_]*[Dd]eployment(?:Name|Id|_name|_id)?';

const OPENROUTER_CONTEXT = /openrouter/i;
// OpenRouter's model namespaces (its own `openrouter/auto` router included). A provider/model
// string outside these is not counted, which keeps endpoint slugs and import paths out.
const OPENROUTER_ID = new RegExp(
  `^(${[
    'openai',
    'anthropic',
    'google',
    'meta-llama',
    'mistralai',
    'cohere',
    'deepseek',
    'x-ai',
    'qwen',
    'amazon',
    'microsoft',
    'nvidia',
    'perplexity',
    'moonshotai',
    'z-ai',
    'thudm',
    'minimax',
    'ai21',
    'baidu',
    'bytedance',
    'tencent',
    'alibaba',
    'inflection',
    'liquid',
    'nousresearch',
    'cognitivecomputations',
    'black-forest-labs',
    'arcee-ai',
    'allenai',
    'openrouter',
  ].join('|')})\\/([a-z0-9][a-z0-9.:_-]*)$`,
);
// Dated model IDs: OpenRouter passes these through to the provider unchanged.
const DATED = /-\d{4}(?:-\d{2}-\d{2})?$|-\d{8}$|-\d{4}$/;

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const QUOTED = /(['"`])([^'"`\s]{2,200})\1/g;

function quoted(line: string) {
  return [...line.matchAll(QUOTED)].map((match) => ({
    value: match[2],
    column: match.index! + 1,
  }));
}

function excerpt(line: string) {
  const text = line.trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function bedrockSite(
  value: string,
  bedrockFile: boolean,
): Pick<ModelHostSite, 'value' | 'upstream'> | undefined {
  const id = BEDROCK_ARN.exec(value)?.[1] ?? value;
  if (
    !BEDROCK_ID.test(id) &&
    !BEDROCK_ARN.test(value) &&
    !(bedrockFile && BEDROCK_UNVERSIONED.test(id))
  )
    return undefined;
  const anthropic = BEDROCK_ANTHROPIC.exec(id);
  return {
    value,
    upstream: anthropic ? { provider: 'anthropic', model: anthropic[1] } : null,
  };
}

// Every host model site in the repository's JS/TS source, in file and line order.
export function detectModelHosts(repository: Pick<Repository, 'files'>): ModelHostSite[] {
  const sites: ModelHostSite[] = [];
  for (const file of repository.files) {
    if (!SOURCE.test(file.path)) continue;
    const bedrockFile = BEDROCK_CONTEXT.test(file.path) || BEDROCK_CONTEXT.test(file.content);
    const azureClient = AZURE_CLIENT.test(file.content);
    const azureFile =
      azureClient || AZURE_CONTEXT.test(file.path) || AZURE_CONTEXT.test(file.content);
    const openrouterFile =
      OPENROUTER_CONTEXT.test(file.path) || OPENROUTER_CONTEXT.test(file.content);
    for (const [index, line] of file.content.split('\n').entries()) {
      const at = (column: number, rest: Omit<ModelHostSite, 'file' | 'line' | 'column' | 'text'>) =>
        sites.push({ file: file.path, line: index + 1, column, text: excerpt(line), ...rest });
      const hostShaped = new Set<string>();
      for (const { value, column } of quoted(line)) {
        // A versioned Bedrock ID or an ARN is evidence on its own; unversioned IDs need context.
        const bedrock = bedrockSite(value, bedrockFile);
        if (bedrock) {
          hostShaped.add(value);
          at(column, {
            host: 'bedrock',
            kind: 'model-id',
            ...bedrock,
            stop: 'bedrock-lifecycle-unknown',
          });
        }
        const routed = openrouterFile ? OPENROUTER_ID.exec(value) : null;
        if (routed) {
          hostShaped.add(value);
          at(column, {
            host: 'openrouter',
            kind: 'model-id',
            value,
            upstream:
              routed[1] === 'openrouter'
                ? null
                : { provider: OPENROUTER_PROVIDERS[routed[1]] ?? routed[1], model: routed[2] },
            stop: DATED.test(routed[2]) ? null : 'openrouter-alias',
          });
        }
      }
      if (!azureFile) continue;
      const apiVersion = (value: string, column: number) =>
        at(column, {
          host: 'azure-openai',
          kind: 'api-version',
          value,
          upstream: null,
          stop: 'azure-api-version-lifecycle-unknown',
        });
      const deployment = (value: string, column: number) => {
        if (hostShaped.has(value)) return;
        at(column, {
          host: 'azure-openai',
          kind: 'deployment',
          value,
          upstream: null,
          stop: 'azure-deployment-name',
        });
      };
      // `apiVersion: '2024-02-15-preview'` on a client, `'api-version': '…'` in query options, or
      // `api-version=` in a REST URL (`v1` is Azure's unversioned v1 API).
      for (const match of line.matchAll(
        new RegExp(
          `(?:\\b(?:apiVersion|api_version|[A-Za-z_]*API_VERSION)\\b|['"]api-version['"])[^'"\`\\n]{0,40}(['"\`])(${AZURE_API_VERSION})\\1`,
          'g',
        ),
      ))
        apiVersion(match[2], match.index! + match[0].lastIndexOf(match[2]) + 1);
      for (const match of line.matchAll(
        new RegExp(`[?&]api-version=(${AZURE_API_VERSION}|v1)\\b`, 'g'),
      ))
        apiVersion(match[1], match.index! + match[0].indexOf(match[1]) + 1);
      // Deployments: a key that says deployment, the `model` an Azure client's request sends
      // (Azure routes it to a deployment of that name), a REST path segment, or an env value.
      const keys = azureClient ? `(?:${DEPLOYMENT_KEY}|model)` : DEPLOYMENT_KEY;
      for (const match of line.matchAll(
        new RegExp(
          `\\b${keys}\\s*:\\s*(?:(['"\`])([\\w.-]{1,64})\\1|([A-Za-z_$][\\w$.]*(?:\\[['"]\\w+['"]\\])?)\\s*[,}])`,
          'g',
        ),
      ))
        deployment(match[2] ?? match[3], match.index! + match[0].indexOf(match[2] ?? match[3]) + 1);
      for (const match of line.matchAll(
        /\/openai\/deployments\/(?:\$\{([^}]{1,80})\}|([\w.-]{1,64}))(?=[/?"'`]|$)/g,
      ))
        deployment(match[1] ?? match[2], match.index! + match[0].indexOf(match[1] ?? match[2]) + 1);
      for (const match of line.matchAll(
        /['"]AZURE_OPENAI_\w*DEPLOYMENT\w*['"]\s*,\s*['"]([\w.-]{1,64})['"]/g,
      ))
        deployment(match[1], match.index! + match[0].lastIndexOf(match[1]) + 1);
    }
  }
  return sites;
}

export interface HostDeadlineMatch {
  provider: string;
  version: string;
  site: ModelHostSite;
  text: string;
}

// OpenRouter namespaces whose registry provider has another name.
const OPENROUTER_PROVIDERS: Record<string, string> = { google: 'gemini' };

const HOST_NAMES: Record<ModelHost, string> = {
  bedrock: 'Amazon Bedrock',
  'azure-openai': 'Azure OpenAI',
  openrouter: 'OpenRouter',
};

// The registry entries host sites reach. An OpenRouter ID whose upstream part is exactly a registry
// model of that provider (`openai/gpt-4.5-preview`) matches that model's entry: OpenRouter forwards
// a dated ID unchanged. Bedrock and Azure sites match only entries the registry keeps for that
// host itself (provider `bedrock` or `azure-openai`), never the provider's own API date, because
// the clouds retire models on their own schedules.
export function hostDeadlineMatches(
  sites: ModelHostSite[],
  hasEntry: (provider: string, version: string) => boolean,
): HostDeadlineMatch[] {
  const matches: HostDeadlineMatch[] = [];
  for (const site of sites) {
    const [provider, version] =
      site.host === 'openrouter' && site.upstream
        ? [site.upstream.provider, site.upstream.model]
        : [site.host, site.value];
    if (!hasEntry(provider, version)) continue;
    matches.push({
      provider,
      version,
      site,
      text: `${HOST_NAMES[site.host]} ${site.kind} ${site.value}${site.host === 'openrouter' ? ` routes to ${provider} ${version}` : ''}: ${site.text}`,
    });
  }
  return matches;
}

// Host sites as report-only stops for the model-replacement rule (pipeline/model-retirements.ts),
// so a host's model is never edited as if it were the provider's own API.
export function modelHostStops(repository: Pick<Repository, 'files'>) {
  return detectModelHosts(repository).map((site) => ({
    file: site.file,
    line: site.line,
    model: site.host === 'openrouter' && site.upstream ? site.upstream.model : site.value,
    call: HOST_NAMES[site.host],
    reason:
      site.stop === 'azure-deployment-name'
        ? `Azure OpenAI deployment ${site.value}: check which model the deployment runs in Azure.`
        : site.host === 'openrouter'
          ? `OpenRouter model ${site.value}: it routes to ${site.upstream?.provider ?? 'its provider'}, so change it in the OpenRouter call.`
          : `${HOST_NAMES[site.host]} ${site.kind} ${site.value}: the host sets its own retirement dates.`,
  }));
}
