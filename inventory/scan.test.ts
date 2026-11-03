import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { npmProvider, pythonModuleProvider } from './catalog.ts';
import { scanEvidence, scanRepo, type ScanResult } from './scan.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

// A small Next.js-style app: Stripe through an exported client, Supabase through the repo's own
// createClient() wrapper, OpenAI with a model, a raw fetch to a known host, one to an unknown host,
// one to the app's own route, and dependencies the catalog does not know.
const FILES: Record<string, string> = {
  'package.json': `{
  "dependencies": {
    "stripe": "^14.2.0",
    "@supabase/ssr": "^0.5.0",
    "openai": "^4.20.0",
    "left-pad": "^1.3.0",
    "weather-sdk-acme": "^2.0.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
`,
  'package-lock.json': `{
  "packages": {
    "node_modules/stripe": {
      "version": "14.25.0"
    }
  }
}
`,
  'src/lib/stripe.ts': `import Stripe from 'stripe';
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});
`,
  'src/app/checkout.ts': `import { stripe } from '@/lib/stripe';

export async function checkout(customer: string) {
  const session = await stripe.checkout.sessions.create({
    customer,
    mode: 'subscription',
    line_items: [{ price: 'price_123', quantity: 1 }],
  });
  return session.url;
}
`,
  'src/app/webhook.ts': `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
export async function POST(req: Request) {
  const event = stripe.webhooks.constructEvent(await req.text(), req.headers.get('stripe-signature')!, process.env.STRIPE_WEBHOOK_SECRET!);
  return event.type;
}
`,
  'src/utils/supabase/server.ts': `import { createServerClient } from '@supabase/ssr';

export async function createClient() {
  return createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {});
}
`,
  'src/app/page.tsx': `import { createClient } from '@/utils/supabase/server';

export default async function Page() {
  const supabase = await createClient();
  const { data } = await supabase
    .from('todos')
    .select();
  const { data: user } = await supabase.auth.getUser();
  return data;
}
`,
  'src/app/ai.ts': `import OpenAI from 'openai';
const client = new OpenAI();
export async function ask(question: string) {
  const reply = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: question }],
  });
  return reply.choices[0].message.content;
}
`,
  'src/app/raw.ts': `export async function moderate(input: string) {
  const response = await fetch('https://api.openai.com/v1/moderations', { method: 'POST', body: JSON.stringify({ input }) });
  return response.json();
}
export async function forecast(city: string) {
  return fetch(\`https://api.weather.example.net/v2/forecast?q=\${city}\`);
}
export async function mine() {
  return fetch('/api/me');
}
`,
  'scripts/billing.py': `import stripe
from openai import OpenAI

stripe.api_key = "not-a-key"
client = OpenAI()

def run():
    stripe.Customer.create(email="a@example.com", name="A")
    client.responses.create(model="gpt-4.1", input="hi")
`,
  '.env': 'STRIPE_SECRET_KEY=value-that-must-never-appear\n',
  '.env.example': 'STRIPE_SECRET_KEY=\nWEATHER_API_URL=\n',
};

let repoDir: string;
let scan: ScanResult;
beforeAll(async () => {
  repoDir = await makeRepo(FILES);
  scan = await scanRepo(repoDir, 'acme/shop');
});
afterAll(async () => removeRepo(repoDir));

const usage = (provider: string, via: string, sdk?: string, python = false) =>
  scan.usages.find(
    (found) =>
      found.provider === provider &&
      found.via === via &&
      found.sdk?.name === sdk &&
      (found.ecosystem === 'python') === python,
  );

describe('catalog', () => {
  it('maps packages, subpaths, scopes and Python modules to provider ids', () => {
    expect(npmProvider('openai/resources/index')?.provider).toBe('openai');
    expect(npmProvider('@supabase/auth-helpers-nextjs')?.provider).toBe('supabase');
    expect(npmProvider('@aws-sdk/client-bedrock-runtime')?.provider).toBe('aws-bedrock');
    expect(npmProvider('@google/genai')?.provider).toBe('gemini');
    expect(npmProvider('left-pad')).toBeUndefined();
    expect(pythonModuleProvider('google.generativeai')?.provider).toBe('gemini');
    expect(pythonModuleProvider('twilio.rest')?.provider).toBe('twilio');
    expect(pythonModuleProvider('google.cloud.storage')).toBeUndefined();
  });
});

describe('scanRepo', () => {
  it('builds an SDK usage from an exported client, with the locked version and the pinned API version', () => {
    const stripe = usage('stripe', 'sdk', 'stripe');
    expect(stripe).toMatchObject({
      repo: 'acme/shop',
      sdk: { name: 'stripe', version: '14.25.0', lockfile: 'package-lock.json' },
      pinnedVersion: { value: '2023-10-16', file: 'src/lib/stripe.ts', line: 3 },
    });
    expect(stripe?.callSites).toEqual([
      expect.objectContaining({
        file: 'src/app/checkout.ts',
        line: 4,
        operation: 'checkout.sessions.create',
        fields: ['customer', 'mode', 'line_items'],
      }),
      expect.objectContaining({
        file: 'src/app/webhook.ts',
        line: 4,
        operation: 'webhooks.constructEvent',
      }),
    ]);
    expect(stripe?.hints?.packages).toContain('stripe');
    expect(stripe?.hints?.hosts).toContain('api.stripe.com');
  });

  it("makes the SDK's webhook check its own webhook usage", () => {
    expect(usage('stripe', 'webhook')?.callSites).toEqual([
      expect.objectContaining({ file: 'src/app/webhook.ts', line: 4 }),
    ]);
  });

  it("follows the repo's own factory to the client it returns, and a call split over lines", () => {
    const supabase = usage('supabase', 'sdk', '@supabase/ssr');
    expect(
      supabase?.callSites.map((site) => `${site.file}:${site.line} ${site.operation}`),
    ).toEqual(['src/app/page.tsx:6 from', 'src/app/page.tsx:8 auth.getUser']);
  });

  it('reads the model a call names as the version an LLM usage pins', () => {
    const openai = usage('openai', 'sdk', 'openai');
    expect(openai?.pinnedVersion).toEqual({ value: 'gpt-4o-mini', file: 'src/app/ai.ts', line: 5 });
    expect(openai?.callSites[0]).toMatchObject({
      operation: 'chat.completions.create',
      notes: expect.stringContaining('Model "gpt-4o-mini"'),
    });
  });

  it('reads Python modules, their clients and calls, apart from the npm SDK of the same name', () => {
    expect(usage('stripe', 'sdk', 'stripe', true)?.callSites).toEqual([
      expect.objectContaining({
        file: 'scripts/billing.py',
        line: 8,
        operation: 'Customer.create',
        fields: ['email', 'name'],
      }),
    ]);
    const openai = usage('openai', 'sdk', 'openai', true);
    expect(openai?.callSites).toEqual([
      expect.objectContaining({
        file: 'scripts/billing.py',
        line: 9,
        operation: 'responses.create',
      }),
    ]);
    expect(openai?.pinnedVersion).toEqual({
      value: 'gpt-4.1',
      file: 'scripts/billing.py',
      line: 9,
    });
    // Undeclared, so its version is unknown rather than borrowed from package-lock.json.
    expect(usage('stripe', 'sdk', 'stripe', true)?.sdk).toEqual({ name: 'stripe', version: '' });
  });

  it('records a fetch to a known API host as raw HTTP and leaves an unknown host to the agent', () => {
    expect(usage('openai', 'http')?.callSites).toEqual([
      expect.objectContaining({
        file: 'src/app/raw.ts',
        line: 2,
        operation: 'POST /v1/moderations',
      }),
    ]);
    const raw = scan.leads.find((lead) => lead.kind === 'raw-http');
    expect(raw?.items).toEqual([expect.stringContaining('src/app/raw.ts:6')]);
    expect(scan.internalCalls.count).toBe(1);
  });

  it('hands every dependency it does not know to the agent, and never reads a real env file', () => {
    const unknown = scan.leads.find((lead) => lead.kind === 'unknown-dependencies');
    expect(unknown?.items).toEqual(['package.json: left-pad, weather-sdk-acme']);
    const evidence = scanEvidence(scan);
    expect(evidence).toContain('WEATHER_API_URL');
    expect(evidence).toContain('api.weather.example.net');
    expect(evidence).not.toContain('value-that-must-never-appear');
    expect(JSON.stringify(scan)).not.toContain('value-that-must-never-appear');
  });

  it('flags a file that imports a known SDK where it found no call', async () => {
    const dir = await makeRepo({
      'package.json': '{\n  "dependencies": {\n    "resend": "^3.0.0"\n  }\n}\n',
      'lib/mail.ts': `import { Resend } from 'resend';
export function mailer() {
  return new Resend(process.env.RESEND_KEY);
}
`,
      'lib/wrapped.ts': `import { Resend } from 'resend';
export const send = (r: Resend) => r;
`,
    });
    const result = await scanRepo(dir, 'acme/mail');
    const lead = result.leads.find((found) => found.kind === 'sdk-without-calls');
    expect(lead?.items.join('\n')).toContain(
      'resend (resend): no call found in lib/mail.ts, lib/wrapped.ts',
    );
    expect(result.usages).toEqual([]);
    await removeRepo(dir);
  });

  it('records a UI-only SDK by its components, reads calls with type arguments, and lists base URLs', async () => {
    const dir = await makeRepo({
      'package.json':
        '{\n  "dependencies": {\n    "@vercel/analytics": "^1.5.0",\n    "next-sanity": "^9.0.0",\n    "openai": "^4.0.0"\n  }\n}\n',
      'app/layout.tsx': `import { Analytics } from '@vercel/analytics/react';
export default function Layout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Analytics
          mode="production"
        />
      </body>
    </html>
  );
}
`,
      'lib/sanity.tsx': `import { createClient, PortableText } from 'next-sanity';
export const client = createClient({ projectId: 'p', dataset: 'production' });
export const posts = () => client.fetch<{ title: string }[]>('*[_type == "post"]');
export const Body = ({ value }) => <PortableText value={value} />;
`,
      'lib/deepseek.ts': `import OpenAI from 'openai';
export const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com/v1',
});
`,
    });
    const result = await scanRepo(dir, 'acme/site');
    const sites = (provider: string) =>
      result.usages
        .filter((found) => found.provider === provider)
        .flatMap((found) =>
          found.callSites.map((site) => `${site.file}:${site.line} ${site.operation}`),
        );
    expect(sites('vercel')).toEqual(['app/layout.tsx:7 <Analytics />']);
    // next-sanity has a real call, so its <PortableText /> is rendering, not a request.
    expect(sites('sanity')).toEqual(['lib/sanity.tsx:3 fetch']);
    const baseUrls = result.leads.find((lead) => lead.kind === 'base-urls');
    expect(baseUrls?.items).toEqual([expect.stringContaining('lib/deepseek.ts:3')]);
    await removeRepo(dir);
  });

  it('keeps two SDKs apart when two classes give the same holder a client', async () => {
    const dir = await makeRepo({
      'package.json':
        '{\n  "dependencies": {\n    "@anthropic-ai/sdk": "^0.30.0",\n    "openai": "^4.0.0"\n  }\n}\n',
      'llm.js': `const Anthropic = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');
class Claude {
  constructor(key) {
    this.client = new Anthropic({ apiKey: key });
  }
  ask(text) {
    return this.client.messages.create({ model: 'claude-x', messages: [] });
  }
}
class Gpt {
  constructor(key) {
    this.client = new OpenAI({ apiKey: key });
  }
  ask(text) {
    return this.client.chat.completions.create({ model: 'gpt-x', messages: [] });
  }
}
module.exports = { Claude, Gpt };
`,
    });
    const result = await scanRepo(dir, 'acme/llm');
    const sites = (provider: string) =>
      result.usages
        .filter((found) => found.provider === provider)
        .flatMap((found) => found.callSites.map((site) => `${site.line} ${site.operation}`));
    expect(sites('anthropic')).toEqual(['8 messages.create']);
    expect(sites('openai')).toEqual(['16 chat.completions.create']);
    await removeRepo(dir);
  });

  it('suggests areas for area readers only when there are many leads to read', async () => {
    // An LLM gateway's layout, like lobe-chat's src/libs/agent-runtime/<provider>/index.ts.
    const providers = Array.from({ length: 70 }, (_, index) => [
      `src/libs/agent-runtime/p${index}/index.ts`,
      `export const p${index} = { baseURL: 'https://api.vendor${index}.example-ai.io/v1' };\n`,
    ]);
    const many = await makeRepo({
      'package.json': '{\n  "dependencies": {}\n}\n',
      // A raw fetch counts toward fanning out; a webhook signal alone does not.
      'src/app/proxy.ts': 'export const get = (url: string) => fetch(url);\n',
      'src/app/hook.ts': "export const verify = (body: string) => createHmac('sha256', body);\n",
      ...Object.fromEntries(providers),
    });
    const result = await scanRepo(many, 'acme/gateway');
    expect(result.areas).toEqual([
      { area: 'src/libs/agent-runtime', leads: 70 },
      { area: 'src/app', leads: 1 },
    ]);
    expect(scanEvidence(result)).toContain('## Suggested areas for area readers');
    await removeRepo(many);
    expect(scan.areas).toEqual([]);
    expect(scanEvidence(scan)).not.toContain('Suggested areas');
  });

  it('ties a fetch with a runtime URL to the one known API host its file names, and leaves the rest as leads', async () => {
    const dir = await makeRepo({
      'package.json': '{\n  "dependencies": {}\n}\n',
      'lib/models.ts': `const BASE = 'https://api.anthropic.com';
export async function models(key: string) {
  const url = \`\${BASE}/v1/models\`;
  const response = await fetch(url, { method: 'GET', headers: { 'x-api-key': key } });
  return response.json();
}
`,
      'lib/two.ts': `const A = 'https://api.anthropic.com';
const B = 'https://api.example-vendor.io';
export const get = (url: string) => fetch(url);
`,
    });
    const result = await scanRepo(dir, 'acme/models');
    expect(result.usages).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        via: 'http',
        callSites: [
          expect.objectContaining({
            file: 'lib/models.ts',
            line: 4,
            operation: 'GET (URL built at runtime)',
          }),
        ],
      }),
    ]);
    const raw = result.leads.find((lead) => lead.kind === 'raw-http');
    expect(raw?.items).toEqual([
      expect.stringContaining(
        'lib/two.ts:3: export const get = (url: string) => fetch(url); [this file names api.anthropic.com, api.example-vendor.io]',
      ),
    ]);
    await removeRepo(dir);
  });
});
