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
  `^(?:(?:us|eu|apac|global|us-gov|ca|jp|au|ap)\\.)?(?:${BEDROCK_PROVIDERS})\\.[a-z0-9][a-z0-9.-]*?(?:-v\\d+(?::\\d+)?|:\\d+)(?::\\d+k)?$`,
);
const BEDROCK_ARN =
  /^arn:aws(?:-[a-z]+)?:bedrock:[a-z0-9-]*:\d*:(?:foundation-model|inference-profile|application-inference-profile|provisioned-model)\/(.+)$/;
// Newer Bedrock IDs drop the version suffix (`us.anthropic.claude-haiku-5-5` in AWS's own
// examples); they count only in a file that uses a Bedrock SDK.
const BEDROCK_UNVERSIONED = new RegExp(
  `^(?:(?:us|eu|apac|global|us-gov|ca|jp|au|ap)\\.)?(?:${BEDROCK_PROVIDERS})\\.[a-z0-9][a-z0-9.]*-[a-z0-9.-]*[a-z0-9]$`,
);
const BEDROCK_ANTHROPIC = /^(?:[a-z-]{2,6}\.)?anthropic\.(claude-[a-z0-9.-]+?)(?:-v\d+(?::\d+)?)?$/;
const BEDROCK_IMPORT =
  /['"](?:@aws-sdk\/client-bedrock-runtime|@aws-sdk\/client-bedrock|@anthropic-ai\/bedrock-sdk|@ai-sdk\/amazon-bedrock|@langchain\/aws)['"]/;

// Azure's v1 endpoint uses the plain OpenAI client, so its endpoint or settings mark the file too.
const AZURE_IMPORT =
  /\bAzureOpenAI\b|['"]@azure\/openai['"]|\.openai\.azure\.com|\.cognitiveservices\.azure\.com|\bAZURE_OPENAI_\w+/;
const AZURE_API_VERSION = /^\d{4}-\d{2}-\d{2}(?:-preview)?$/;

const OPENROUTER_CONTEXT =
  /openrouter\.ai|['"]@openrouter\/ai-sdk-provider['"]|['"]openrouter['"]/i;
const OPENROUTER_ID =
  /^(openai|anthropic|google|meta-llama|mistralai|cohere|deepseek|x-ai|qwen|amazon|microsoft|nvidia|perplexity)\/([a-z0-9][a-z0-9.:_-]*)$/;
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
    const bedrockFile = BEDROCK_IMPORT.test(file.content);
    const azureFile = AZURE_IMPORT.test(file.content);
    const openrouterFile = OPENROUTER_CONTEXT.test(file.content);
    for (const [index, line] of file.content.split('\n').entries()) {
      const at = (column: number, rest: Omit<ModelHostSite, 'file' | 'line' | 'column' | 'text'>) =>
        sites.push({ file: file.path, line: index + 1, column, text: excerpt(line), ...rest });
      for (const { value, column } of quoted(line)) {
        // A full Bedrock ID or ARN is evidence on its own; anywhere else it is not a hostname.
        const bedrock = bedrockSite(value, bedrockFile);
        if (bedrock && (bedrockFile || BEDROCK_ARN.test(value) || /-v\d+:\d+$/.test(value)))
          at(column, {
            host: 'bedrock',
            kind: 'model-id',
            ...bedrock,
            stop: 'bedrock-lifecycle-unknown',
          });
        const routed = openrouterFile ? OPENROUTER_ID.exec(value) : null;
        if (routed)
          at(column, {
            host: 'openrouter',
            kind: 'model-id',
            value,
            upstream: { provider: routed[1], model: routed[2] },
            stop: DATED.test(routed[2]) ? null : 'openrouter-alias',
          });
      }
      if (!azureFile) continue;
      // `apiVersion: '2024-02-15-preview'` on the client, or `api-version=` in a REST URL.
      for (const match of line.matchAll(
        /\b(?:apiVersion|api_version|AZURE_OPENAI_API_VERSION)\b[^'"`\n]{0,40}(['"`])(\d{4}-\d{2}-\d{2}(?:-preview)?)\1/g,
      ))
        at(match.index! + match[0].indexOf(match[2]) + 1, {
          host: 'azure-openai',
          kind: 'api-version',
          value: match[2],
          upstream: null,
          stop: 'azure-api-version-lifecycle-unknown',
        });
      for (const match of line.matchAll(/[?&]api-version=(\d{4}-\d{2}-\d{2}(?:-preview)?)/g))
        if (AZURE_API_VERSION.test(match[1]))
          at(match.index! + match[0].indexOf(match[1]) + 1, {
            host: 'azure-openai',
            kind: 'api-version',
            value: match[1],
            upstream: null,
            stop: 'azure-api-version-lifecycle-unknown',
          });
      // Deployment names: the client's `deployment`, a REST path segment, or the `model` an
      // AzureOpenAI request sends (Azure routes it to a deployment of that name).
      for (const match of line.matchAll(
        /\b(?:deployment|deploymentName|deployment_name|azureDeployment|model)\s*:\s*(['"`])([\w.-]{1,64})\1/g,
      ))
        at(match.index! + match[0].indexOf(match[2]) + 1, {
          host: 'azure-openai',
          kind: 'deployment',
          value: match[2],
          upstream: null,
          stop: 'azure-deployment-name',
        });
      // A deployment held in a variable or setting: the name to look up in Azure.
      for (const match of line.matchAll(
        /\b(?:deployment|deploymentName|deployment_name|azureDeployment|model)\s*:\s*([A-Za-z_$][\w$.]*(?:\[['"]\w+['"]\])?)\s*[,}]/g,
      ))
        at(match.index! + match[0].indexOf(match[1]) + 1, {
          host: 'azure-openai',
          kind: 'deployment',
          value: match[1],
          upstream: null,
          stop: 'azure-deployment-name',
        });
      for (const match of line.matchAll(/\/openai\/deployments\/([\w.-]{1,64})\//g))
        at(match.index! + match[0].indexOf(match[1]) + 1, {
          host: 'azure-openai',
          kind: 'deployment',
          value: match[1],
          upstream: null,
          stop: 'azure-deployment-name',
        });
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
