// Known SDKs and API hosts, so the code scan can build a usage with no AI call when a repo uses one
// of them in the plain way: import, client, member call. A shortcut, never a gate: a package or
// host that is not here goes to the agent as a lead, and the agent can find anything the scan
// cannot. Provider ids match the provider folders and the eval sets ("gemini", not "google").

export type Ecosystem = 'npm' | 'python' | 'go' | 'ruby';

export type CatalogEntry = {
  provider: string;
  /** npm package names, or scope prefixes ending in "/" such as "@sentry/". */
  npm?: string[];
  /** PyPI names as manifests spell them, with the module paths they are imported as. */
  python?: { packages: string[]; modules: string[] };
  /** Go module path prefixes and Ruby gem names, for the version and the lead (no call sites yet). */
  go?: string[];
  ruby?: string[];
  hosts?: string[];
  docsUrls?: string[];
  /** LLM APIs: the model a call names is the version it pins. */
  models?: boolean;
};

export const CATALOG: CatalogEntry[] = [
  {
    provider: 'stripe',
    npm: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js'],
    python: { packages: ['stripe'], modules: ['stripe'] },
    go: ['github.com/stripe/stripe-go'],
    ruby: ['stripe'],
    hosts: ['api.stripe.com', 'js.stripe.com', 'checkout.stripe.com', 'billing.stripe.com'],
    docsUrls: ['https://docs.stripe.com/changelog'],
  },
  {
    provider: 'openai',
    npm: ['openai', '@ai-sdk/openai', '@langchain/openai'],
    python: {
      packages: ['openai', 'langchain-openai', 'llama-index-llms-openai'],
      modules: ['openai', 'langchain_openai', 'llama_index.llms.openai'],
    },
    go: ['github.com/sashabaranov/go-openai', 'github.com/openai/openai-go'],
    ruby: ['ruby-openai', 'openai'],
    hosts: ['api.openai.com'],
    docsUrls: ['https://platform.openai.com/docs/deprecations'],
    models: true,
  },
  {
    provider: 'anthropic',
    npm: ['@anthropic-ai/sdk', '@ai-sdk/anthropic', '@langchain/anthropic'],
    python: {
      packages: ['anthropic', 'langchain-anthropic'],
      modules: ['anthropic', 'langchain_anthropic'],
    },
    go: ['github.com/anthropics/anthropic-sdk-go'],
    hosts: ['api.anthropic.com'],
    docsUrls: ['https://docs.anthropic.com/en/release-notes/api'],
    models: true,
  },
  {
    provider: 'gemini',
    npm: ['@google/generative-ai', '@google/genai', '@ai-sdk/google', '@langchain/google-genai'],
    python: {
      packages: ['google-generativeai', 'google-genai', 'langchain-google-genai'],
      modules: ['google.generativeai', 'google.genai', 'langchain_google_genai'],
    },
    go: ['github.com/google/generative-ai-go', 'google.golang.org/genai'],
    hosts: ['generativelanguage.googleapis.com'],
    docsUrls: ['https://ai.google.dev/gemini-api/docs/changelog'],
    models: true,
  },
  {
    provider: 'mistral',
    npm: ['@mistralai/mistralai', '@ai-sdk/mistral'],
    python: { packages: ['mistralai'], modules: ['mistralai'] },
    hosts: ['api.mistral.ai'],
    models: true,
  },
  {
    provider: 'groq',
    npm: ['groq-sdk', '@ai-sdk/groq'],
    python: { packages: ['groq'], modules: ['groq'] },
    hosts: ['api.groq.com'],
    models: true,
  },
  {
    provider: 'cohere',
    npm: ['cohere-ai', '@ai-sdk/cohere'],
    python: { packages: ['cohere'], modules: ['cohere'] },
    hosts: ['api.cohere.com', 'api.cohere.ai'],
    models: true,
  },
  {
    provider: 'together',
    npm: ['together-ai'],
    python: { packages: ['together'], modules: ['together'] },
    hosts: ['api.together.xyz'],
    models: true,
  },
  {
    provider: 'replicate',
    npm: ['replicate'],
    python: { packages: ['replicate'], modules: ['replicate'] },
    hosts: ['api.replicate.com'],
    models: true,
  },
  {
    provider: 'huggingface',
    npm: ['@huggingface/inference'],
    python: { packages: ['huggingface_hub', 'huggingface-hub'], modules: ['huggingface_hub'] },
    hosts: ['api-inference.huggingface.co', 'huggingface.co'],
  },
  { provider: 'ollama', npm: ['ollama'], python: { packages: ['ollama'], modules: ['ollama'] } },
  {
    provider: 'elevenlabs',
    npm: ['elevenlabs', '@elevenlabs/elevenlabs-js'],
    python: { packages: ['elevenlabs'], modules: ['elevenlabs'] },
    hosts: ['api.elevenlabs.io'],
  },
  {
    provider: 'deepgram',
    npm: ['@deepgram/sdk'],
    python: { packages: ['deepgram-sdk'], modules: ['deepgram'] },
    hosts: ['api.deepgram.com'],
  },
  {
    provider: 'assemblyai',
    npm: ['assemblyai'],
    python: { packages: ['assemblyai'], modules: ['assemblyai'] },
    hosts: ['api.assemblyai.com'],
  },
  {
    provider: 'pinecone',
    npm: ['@pinecone-database/pinecone'],
    python: { packages: ['pinecone', 'pinecone-client'], modules: ['pinecone'] },
  },
  {
    provider: 'langfuse',
    npm: ['langfuse', 'langfuse-node'],
    python: { packages: ['langfuse'], modules: ['langfuse'] },
  },
  {
    provider: 'twilio',
    npm: ['twilio'],
    python: { packages: ['twilio'], modules: ['twilio'] },
    go: ['github.com/twilio/twilio-go'],
    ruby: ['twilio-ruby'],
    hosts: ['api.twilio.com'],
  },
  {
    provider: 'sendgrid',
    npm: ['@sendgrid/mail', '@sendgrid/client'],
    python: { packages: ['sendgrid'], modules: ['sendgrid'] },
    hosts: ['api.sendgrid.com'],
  },
  {
    provider: 'resend',
    npm: ['resend'],
    python: { packages: ['resend'], modules: ['resend'] },
    hosts: ['api.resend.com'],
  },
  { provider: 'postmark', npm: ['postmark'], hosts: ['api.postmarkapp.com'] },
  { provider: 'mailgun', npm: ['mailgun.js', 'mailgun-js'], hosts: ['api.mailgun.net'] },
  {
    provider: 'mailchimp',
    npm: ['@mailchimp/mailchimp_marketing', '@mailchimp/mailchimp_transactional'],
  },
  {
    provider: 'shopify',
    npm: [
      '@shopify/shopify-api',
      '@shopify/shopify-app-remix',
      '@shopify/shopify-app-express',
      '@shopify/admin-api-client',
      '@shopify/storefront-api-client',
      '@shopify/hydrogen-react',
    ],
    python: { packages: ['ShopifyAPI', 'shopifyapi'], modules: ['shopify'] },
    hosts: ['myshopify.com'],
  },
  {
    provider: 'supabase',
    npm: ['@supabase/'],
    python: { packages: ['supabase'], modules: ['supabase'] },
    hosts: ['supabase.co'],
  },
  {
    provider: 'firebase',
    npm: ['firebase', 'firebase-admin', 'firebase-functions'],
    python: { packages: ['firebase-admin', 'firebase_admin'], modules: ['firebase_admin'] },
    hosts: ['firebaseio.com', 'fcm.googleapis.com', 'firestore.googleapis.com'],
  },
  { provider: 'clerk', npm: ['@clerk/'] },
  { provider: 'auth0', npm: ['@auth0/', 'auth0'] },
  { provider: 'kinde', npm: ['@kinde-oss/'] },
  {
    provider: 'sentry',
    npm: ['@sentry/'],
    python: { packages: ['sentry-sdk', 'sentry_sdk'], modules: ['sentry_sdk'] },
  },
  {
    provider: 'posthog',
    npm: ['posthog-js', 'posthog-node'],
    python: { packages: ['posthog'], modules: ['posthog'] },
    hosts: ['app.posthog.com', 'us.i.posthog.com', 'eu.i.posthog.com'],
  },
  { provider: 'mixpanel', npm: ['mixpanel', 'mixpanel-browser'] },
  { provider: 'segment', npm: ['@segment/analytics-next', '@segment/analytics-node'] },
  { provider: 'vercel', npm: ['@vercel/'] },
  { provider: 'upstash', npm: ['@upstash/'] },
  { provider: 'turso', npm: ['@libsql/client'] },
  { provider: 'uploadthing', npm: ['uploadthing', '@uploadthing/'] },
  { provider: 'cloudinary', npm: ['cloudinary', 'next-cloudinary'], hosts: ['api.cloudinary.com'] },
  { provider: 'algolia', npm: ['algoliasearch', 'react-instantsearch'] },
  {
    provider: 'sanity',
    npm: ['next-sanity', '@sanity/client'],
    hosts: ['api.sanity.io', 'cdn.sanity.io'],
  },
  { provider: 'contentful', npm: ['contentful', 'contentful-management'] },
  { provider: 'mapbox', npm: ['mapbox-gl', '@mapbox/'], hosts: ['api.mapbox.com'] },
  {
    provider: 'github',
    npm: ['octokit', '@octokit/'],
    python: { packages: ['PyGithub', 'pygithub'], modules: ['github'] },
    hosts: ['api.github.com'],
  },
  {
    provider: 'slack',
    npm: ['@slack/'],
    python: {
      packages: ['slack-sdk', 'slack_sdk', 'slack-bolt'],
      modules: ['slack_sdk', 'slack_bolt'],
    },
    hosts: ['slack.com', 'hooks.slack.com'],
  },
  { provider: 'discord', npm: ['discord.js'], hosts: ['discord.com'] },
  {
    provider: 'telegram',
    npm: ['telegraf', 'node-telegram-bot-api', 'grammy'],
    python: { packages: ['python-telegram-bot'], modules: ['telegram'] },
    hosts: ['api.telegram.org'],
  },
  {
    provider: 'notion',
    npm: ['@notionhq/client'],
    python: { packages: ['notion-client'], modules: ['notion_client'] },
    hosts: ['api.notion.com'],
  },
  { provider: 'airtable', npm: ['airtable'], hosts: ['api.airtable.com'] },
  { provider: 'hubspot', npm: ['@hubspot/api-client'], hosts: ['api.hubapi.com'] },
  {
    provider: 'plaid',
    npm: ['plaid', 'react-plaid-link'],
    python: { packages: ['plaid-python'], modules: ['plaid'] },
  },
  { provider: 'paypal', npm: ['@paypal/'], hosts: ['api-m.paypal.com', 'api.paypal.com'] },
  { provider: 'square', npm: ['square'], hosts: ['connect.squareup.com'] },
  { provider: 'lemonsqueezy', npm: ['@lemonsqueezy/lemonsqueezy.js'] },
  { provider: 'paddle', npm: ['@paddle/'] },
  { provider: 'livekit', npm: ['livekit-server-sdk', 'livekit-client', '@livekit/'] },
  { provider: 'heygen', npm: ['@heygen/'], hosts: ['api.heygen.com'] },
  { provider: 'pusher', npm: ['pusher', 'pusher-js'] },
  { provider: 'ably', npm: ['ably'] },
  { provider: 'liveblocks', npm: ['@liveblocks/'] },
  { provider: 'braintrust', npm: ['braintrust'] },
  {
    provider: 'aws',
    npm: ['aws-sdk'],
    python: { packages: ['boto3', 'botocore'], modules: ['boto3', 'botocore'] },
    go: ['github.com/aws/aws-sdk-go'],
  },
];

// Scoped SDK families whose service is part of the id, as the agent names them ("aws-s3").
const FAMILIES: { pattern: RegExp; provider: (service: string) => string }[] = [
  {
    pattern: /^@aws-sdk\/client-(.+)$/,
    provider: (service) => `aws-${service.replace(/-runtime$/, '')}`,
  },
  { pattern: /^@google-cloud\/(.+)$/, provider: (service) => `google-cloud-${service}` },
  { pattern: /^@azure\/(?:openai)$/, provider: () => 'azure-openai' },
];

export type CatalogHit = { provider: string; entry?: CatalogEntry };

/** The catalog provider for an npm package name (or one of its subpath imports), if any. */
export function npmProvider(specifier: string): CatalogHit | undefined {
  const name = npmPackageName(specifier);
  for (const family of FAMILIES) {
    const match = family.pattern.exec(name);
    if (match) return { provider: family.provider(match[1]) };
  }
  const entry = CATALOG.find((candidate) =>
    (candidate.npm ?? []).some((known) =>
      known.endsWith('/') ? name.startsWith(known) : name === known,
    ),
  );
  return entry ? { provider: entry.provider, entry } : undefined;
}

/** "@scope/pkg/sub/path" and "pkg/sub" to the package they come from. */
export function npmPackageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

const normalizePython = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

/** The catalog provider for a dotted Python module path, if any, with the module it matched. */
export function pythonModuleProvider(
  module: string,
): (CatalogHit & { module: string }) | undefined {
  let best: (CatalogHit & { module: string }) | undefined;
  for (const entry of CATALOG) {
    for (const known of entry.python?.modules ?? []) {
      const matches = module === known || module.startsWith(`${known}.`);
      if (matches && (!best || known.length > best.module.length)) {
        best = { provider: entry.provider, entry, module: known };
      }
    }
  }
  return best;
}

/** The catalog provider for a PyPI name as a manifest spells it. */
export function pythonPackageProvider(name: string): CatalogHit | undefined {
  const wanted = normalizePython(name);
  const entry = CATALOG.find((candidate) =>
    (candidate.python?.packages ?? []).some((known) => normalizePython(known) === wanted),
  );
  return entry ? { provider: entry.provider, entry } : undefined;
}

/** The catalog provider for a dependency of any ecosystem the scan reads. */
export function dependencyProvider(ecosystem: string, name: string): CatalogHit | undefined {
  if (ecosystem === 'npm') return npmProvider(name);
  if (ecosystem === 'python') return pythonPackageProvider(name);
  if (ecosystem === 'go') {
    const entry = CATALOG.find((candidate) =>
      (candidate.go ?? []).some((prefix) => name === prefix || name.startsWith(`${prefix}/`)),
    );
    return entry ? { provider: entry.provider, entry } : undefined;
  }
  if (ecosystem === 'ruby') {
    const entry = CATALOG.find((candidate) => (candidate.ruby ?? []).includes(name));
    return entry ? { provider: entry.provider, entry } : undefined;
  }
  return undefined;
}

/** The catalog provider whose API a hostname belongs to, if any. */
export function hostProvider(host: string): CatalogEntry | undefined {
  const name = host.toLowerCase();
  return CATALOG.find((entry) =>
    (entry.hosts ?? []).some((known) => name === known || name.endsWith(`.${known}`)),
  );
}

export function catalogEntry(provider: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.provider === provider);
}
