// Fast pointers for the surfaces agent. They return file paths and lines that often hold a
// platform, infrastructure, security or regulated surface. They miss things and include noise;
// they never decide what is a surface. The agent reads the files and decides.
import path from 'node:path';
import { grepLines, listFiles, readText } from '../repo-files.ts';

export const SURFACE_AREAS = ['platforms', 'infrastructure', 'security', 'regulated'] as const;
export type SurfaceArea = (typeof SURFACE_AREAS)[number];

export type SurfaceLead = {
  area: SurfaceArea;
  signal: string;
  file: string;
  line?: number;
  text?: string;
};

type FileSignal = { area: SurfaceArea; signal: string; test: (file: string) => boolean };
type ContentSignal = {
  area: SurfaceArea;
  signal: string;
  pattern: RegExp;
  files?: (file: string) => boolean;
};

const base = (file: string) => path.posix.basename(file).toLowerCase();
const ext = (file: string) => path.posix.extname(file).toLowerCase();
const isYaml = (file: string) => ['.yaml', '.yml'].includes(ext(file));
const SOURCE = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.rb',
  '.php',
  '.java',
  '.kt',
  '.swift',
  '.cs',
  '.vue',
  '.svelte',
  '.html',
  '.erb',
  '.jinja',
  '.j2',
]);
const isSource = (file: string) => SOURCE.has(ext(file));
const isUi = (file: string) =>
  ['.jsx', '.tsx', '.vue', '.svelte', '.html', '.erb', '.jinja', '.j2'].includes(ext(file)) ||
  file.includes('templates/');
const isConfig = (file: string) =>
  isYaml(file) ||
  ['.json', '.toml', '.ini', '.conf', '.cfg', '.tf', '.env', '.properties'].includes(ext(file)) ||
  base(file).startsWith('.env') ||
  base(file) === 'dockerfile';

// Files whose name alone makes them worth reading.
const FILE_SIGNALS: FileSignal[] = [
  { area: 'platforms', signal: 'iOS Info.plist', test: (f) => base(f) === 'info.plist' },
  {
    area: 'platforms',
    signal: 'iOS privacy manifest',
    test: (f) => base(f) === 'privacyinfo.xcprivacy',
  },
  { area: 'platforms', signal: 'Xcode project', test: (f) => f.endsWith('.pbxproj') },
  {
    area: 'platforms',
    signal: 'CocoaPods / SwiftPM',
    test: (f) => ['podfile', 'package.swift'].includes(base(f)),
  },
  {
    area: 'platforms',
    signal: 'Android Gradle build',
    test: (f) => /^build\.gradle(\.kts)?$/.test(base(f)),
  },
  {
    area: 'platforms',
    signal: 'Android manifest',
    test: (f) => base(f) === 'androidmanifest.xml',
  },
  {
    area: 'platforms',
    signal: 'Mobile framework config',
    test: (f) =>
      [
        'app.json',
        'app.config.js',
        'app.config.ts',
        'capacitor.config.ts',
        'capacitor.config.json',
        'pubspec.yaml',
        'eas.json',
      ].includes(base(f)),
  },
  { area: 'platforms', signal: 'Browser targets', test: (f) => base(f) === '.browserslistrc' },
  {
    area: 'infrastructure',
    signal: 'Helm chart',
    test: (f) => ['chart.yaml', 'values.yaml'].includes(base(f)),
  },
  {
    area: 'infrastructure',
    signal: 'Kustomize',
    test: (f) => ['kustomization.yaml', 'kustomization.yml'].includes(base(f)),
  },
  {
    area: 'infrastructure',
    signal: 'Serverless Framework',
    test: (f) => /^serverless\.(ya?ml|ts|js|json)$/.test(base(f)),
  },
  {
    area: 'infrastructure',
    signal: 'AWS SAM / CloudFormation template',
    test: (f) => /^(template|samconfig)\.(ya?ml|json|toml)$/.test(base(f)),
  },
  { area: 'infrastructure', signal: 'Terraform', test: (f) => ['.tf', '.tfvars'].includes(ext(f)) },
  { area: 'infrastructure', signal: 'Pulumi', test: (f) => /^pulumi(\..+)?\.ya?ml$/.test(base(f)) },
  {
    area: 'infrastructure',
    signal: 'Cloud deploy config',
    test: (f) =>
      [
        'app.yaml',
        'cloudbuild.yaml',
        'vercel.json',
        'netlify.toml',
        'fly.toml',
        'render.yaml',
        'host.json',
        'function.json',
        'firebase.json',
        'cdk.json',
        'docker-compose.yml',
        'docker-compose.yaml',
        'compose.yaml',
      ].includes(base(f)),
  },
  {
    area: 'security',
    signal: 'Certificate or key file',
    test: (f) => ['.pem', '.crt', '.cer', '.p12', '.pfx', '.jks'].includes(ext(f)),
  },
  {
    area: 'security',
    signal: 'Web server config',
    test: (f) =>
      base(f) === 'nginx.conf' ||
      f.includes('nginx/') ||
      base(f) === 'httpd.conf' ||
      base(f) === 'caddyfile',
  },
];

// Lines whose text often marks a surface. The agent reads around each one.
const CONTENT_SIGNALS: ContentSignal[] = [
  {
    area: 'platforms',
    signal: 'Android SDK level',
    pattern: /\b(targetSdk(Version)?|minSdk(Version)?|compileSdk(Version)?)\b/,
  },
  {
    area: 'platforms',
    signal: 'iOS deployment target',
    pattern: /IPHONEOS_DEPLOYMENT_TARGET|platform\s*:ios|\.iOS\(\.v\d+/,
  },
  {
    area: 'platforms',
    signal: 'Browser extension manifest',
    pattern: /"manifest_version"\s*:/,
    files: (f) => base(f).endsWith('manifest.json'),
  },
  {
    area: 'platforms',
    signal: 'browserslist',
    pattern: /"browserslist"\s*:/,
    files: (f) => base(f) === 'package.json',
  },
  {
    area: 'infrastructure',
    signal: 'Kubernetes object',
    pattern: /^\s*apiVersion:\s*\S+/,
    files: isYaml,
  },
  {
    area: 'infrastructure',
    signal: 'Serverless runtime',
    pattern: /\b(runtime|Runtime)\s*[:=]\s*["']?(nodejs|python|java|dotnet|ruby|go|provided)/,
    files: (f) => isConfig(f) || isSource(f),
  },
  {
    area: 'infrastructure',
    signal: 'Cloud SDK or service',
    pattern:
      /@aws-sdk\/|aws-sdk|boto3|@google-cloud\/|google\.cloud|@azure\/|azure\.|firebase-admin|aws_[a-z_]+"|google_[a-z_]+"|azurerm_/,
  },
  {
    area: 'security',
    signal: 'TLS settings',
    pattern:
      /\b(minVersion|maxVersion|secureProtocol|ssl_protocols|ssl\.PROTOCOL_|TLSv1(\.[0-3])?|tls_version|min_tls_version|MinimumTLSVersion|ciphers?\s*[:=])/i,
  },
  {
    area: 'security',
    signal: 'Certificate checks',
    pattern:
      /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False|InsecureSkipVerify|CERT_NONE|checkServerIdentity|\bca\s*:\s*|certfile|cert_reqs/,
  },
  {
    area: 'security',
    signal: 'OAuth or login flow',
    pattern:
      /oauth|openid|code_challenge|pkce|authorization_code|grant_type|implicit|next-auth|passport\.|authlib|\/authorize\b|redirect_uri/i,
  },
  {
    area: 'security',
    signal: 'Password or basic-auth login to a service',
    pattern:
      /basic\s*auth|auth\s*:\s*\{\s*user|Authorization['"]?\s*:\s*[`'"]Basic|HTTPBasicAuth|smtp\.login|imap|\bpassword\s*[:=]|_PASSWORD\b/i,
  },
  {
    area: 'regulated',
    signal: 'Payments or checkout',
    pattern:
      /stripe|checkout|paymentIntent|payment_intent|card(Number|Element)?\b|braintree|paypal|adyen|square|3ds|three_d_secure|billing/i,
    files: (f) => isSource(f) || isConfig(f),
  },
  {
    area: 'regulated',
    signal: 'Cookies, consent or tracking',
    pattern:
      /cookie|consent|gtag|googletagmanager|google-analytics|analytics|posthog|mixpanel|segment|amplitude|hotjar|fbq\(|pixel|localStorage\.setItem/i,
    files: (f) => isSource(f) || isConfig(f),
  },
  {
    area: 'regulated',
    signal: 'Personal data',
    pattern:
      /sign\s?-?up|register|email|phone|date_?of_?birth|\bdob\b|address|profile|delete\s?account|deleteUser|export(Data|User)|gdpr|ccpa|personal/i,
    files: isSource,
  },
  {
    area: 'regulated',
    signal: 'Forms and interactive UI',
    pattern: /<(form|input|select|textarea|button|img|label)\b|onClick=|role=|aria-/i,
    files: isUi,
  },
  {
    area: 'regulated',
    signal: 'AI feature',
    pattern:
      /openai|anthropic|@google\/generative-ai|gemini|chat\.completions|messages\.create|responses\.create|langchain|llm|chatbot|gpt-|claude-|embedding/i,
    files: (f) => isSource(f) || isConfig(f),
  },
];

const DEFAULT_PER_SIGNAL = 25;

// Returns leads grouped by area. `area` limits the search to one area.
export async function findSurfaceLeads(
  repoDir: string,
  options: { area?: SurfaceArea; perSignal?: number } = {},
): Promise<{ leads: SurfaceLead[]; truncated: string[] }> {
  const files = await listFiles(repoDir);
  const perSignal = options.perSignal ?? DEFAULT_PER_SIGNAL;
  const wanted = (area: SurfaceArea) => !options.area || options.area === area;
  const leads: SurfaceLead[] = [];
  const truncated: string[] = [];

  for (const signal of FILE_SIGNALS.filter((candidate) => wanted(candidate.area))) {
    const matched = files.filter(signal.test);
    for (const file of matched.slice(0, perSignal)) {
      leads.push({ area: signal.area, signal: signal.signal, file });
    }
    if (matched.length > perSignal) truncated.push(signal.signal);
  }

  for (const signal of CONTENT_SIGNALS.filter((candidate) => wanted(candidate.area))) {
    const scoped = signal.files ? files.filter(signal.files) : files;
    const { matches, truncated: more } = await grepLines(repoDir, signal.pattern, {
      files: scoped,
      maxResults: perSignal,
    });
    for (const match of matches) {
      leads.push({ area: signal.area, signal: signal.signal, ...match });
    }
    if (more) truncated.push(signal.signal);
  }

  // A YAML file is a Kubernetes manifest when it has both apiVersion and kind; point at the kind
  // so the agent sees what object it is without opening every YAML file.
  if (wanted('infrastructure')) {
    for (const file of files.filter(isYaml)) {
      const text = await readText(repoDir, file);
      if (!text) continue;
      const lines = text.split('\n');
      if (!lines.some((line) => /^\s*apiVersion:/.test(line))) continue;
      lines.forEach((line, index) => {
        if (/^\s*kind:\s*\S+/.test(line)) {
          leads.push({
            area: 'infrastructure',
            signal: 'Kubernetes kind',
            file,
            line: index + 1,
            text: line.trim(),
          });
        }
      });
    }
  }

  return { leads, truncated };
}

// A compact text form for the model: grouped by area, then by signal.
export function formatLeads(result: { leads: SurfaceLead[]; truncated: string[] }): string {
  if (result.leads.length === 0) return 'No leads. Read the repository directly.';
  const sections: string[] = [];
  for (const area of SURFACE_AREAS) {
    const inArea = result.leads.filter((lead) => lead.area === area);
    if (inArea.length === 0) continue;
    const bySignal = new Map<string, SurfaceLead[]>();
    for (const lead of inArea)
      bySignal.set(lead.signal, [...(bySignal.get(lead.signal) ?? []), lead]);
    const body = [...bySignal.entries()]
      .map(
        ([signal, items]) =>
          `  ${signal}:\n${items
            .map((lead) =>
              lead.line ? `    ${lead.file}:${lead.line}: ${lead.text ?? ''}` : `    ${lead.file}`,
            )
            .join('\n')}`,
      )
      .join('\n');
    sections.push(`${area}:\n${body}`);
  }
  const more =
    result.truncated.length > 0
      ? `\nMore matches not shown for: ${result.truncated.join(', ')}. Use grep to see them.`
      : '';
  return `${sections.join('\n')}${more}\nThese are pointers with noise and gaps. Read the files before recording.`;
}
