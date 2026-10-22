import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDeadlines } from '../deadline-exposure.ts';
import type { DeadlineEntry, DeadlineRegistry } from '../deadline-registry.ts';
import { proposeModelReplacements } from '../model-retirements.ts';
import { goModules, goSdkData, traceGoCalls, traceGoFiles } from './calls.ts';
import { GRAMMAR, GRAMMAR_SHA256 } from './syntax.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-go-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

function entry(
  overrides: Partial<DeadlineEntry> & Pick<DeadlineEntry, 'id' | 'provider' | 'versions'>,
): DeadlineEntry {
  return {
    kind: 'model',
    date: '2026-10-23',
    summary: `${overrides.id} retires.`,
    replacement: null,
    source: 'https://provider.example/deprecations',
    checkedAt: '2026-10-20',
    ...overrides,
  };
}

const registry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    entry({
      id: 'openai-gpt-4',
      provider: 'openai',
      versions: ['gpt-4'],
      replacement: 'gpt-5.6-sol',
    }),
    entry({ id: 'openai-davinci', provider: 'openai', versions: ['text-davinci-003'] }),
    entry({
      id: 'openai-embedding',
      provider: 'openai',
      versions: ['text-embedding-ada-002'],
      replacement: 'text-embedding-3-small',
    }),
    entry({
      id: 'anthropic-opus',
      provider: 'anthropic',
      versions: ['claude-3-opus-latest'],
      replacement: 'claude-opus-4-8',
    }),
  ],
};
const now = new Date('2026-10-22T00:00:00Z');

const HEADER = `package app

import (
	"context"
	"os"

	stripe "github.com/stripe/stripe-go/v84"
	"github.com/stripe/stripe-go/v72/client"
	"github.com/stripe/stripe-go/v84/paymentintent"
	"github.com/stripe/stripe-go/v84/webhook"
	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/responses"
	"github.com/anthropics/anthropic-sdk-go"
)
`;

async function traced(files: Record<string, string>) {
  const calls = await traceGoFiles(
    Object.entries(files).map(([path, content]) => ({ path, content })),
  );
  return calls.map((call) => {
    const model = call.arguments.model;
    return [
      `${call.file}:${call.line} ${call.provider} ${call.resource}.${call.method} ${call.client.kind}`,
      ...(model?.literals ?? []).map((item) => `<- ${item.value}@${item.line} (${item.via})`),
      ...(model?.stop ? [`stop: ${model.stop}`] : []),
    ].join(' ');
  });
}

describe('the vendored grammar and SDK data', () => {
  it('is the published tree-sitter-go 0.25.0 build', async () => {
    const digest = createHash('sha256')
      .update(await readFile(GRAMMAR))
      .digest('hex');
    expect(digest).toBe(GRAMMAR_SHA256);
  });

  it('maps stripe-go releases to API versions and SDK constants to models', async () => {
    const data = await goSdkData();
    expect(data.stripe['github.com/stripe/stripe-go/v72']['v72.0.0']).toBe('2020-08-27');
    expect(data.stripe['github.com/stripe/stripe-go/v84']['v84.4.1']).toBe('2026-02-25.clover');
    expect(data.openai['github.com/openai/openai-go/v3'].constants.ChatModelGPT4o).toBe('gpt-4o');
    expect(
      data.anthropic['github.com/anthropics/anthropic-sdk-go'].constants.ModelClaude3OpusLatest,
    ).toBe('claude-3-opus-latest');
  });
});

describe('tracing Go SDK calls', () => {
  it('traces Stripe calls on new clients, client.API and resource packages', async () => {
    expect(
      await traced({
        'app.go': `${HEADER}
func run(ctx context.Context, params *stripe.CustomerParams) {
	sc := stripe.NewClient("sk")
	sc.V1PaymentIntents.Create(ctx, &stripe.PaymentIntentCreateParams{})
	api := client.New("sk", nil)
	api.Customers.New(params)
	paymentintent.New(&stripe.PaymentIntentParams{})
	webhook.ConstructEvent(nil, "", "")
	stripe.Key = "sk"
}
`,
      }),
    ).toEqual([
      'app.go:18 stripe V1PaymentIntents.Create constructor',
      'app.go:20 stripe Customers.New constructor',
      'app.go:21 stripe paymentintent.New module',
    ]);
  });

  it('traces OpenAI and Anthropic models through literals, SDK constants, conversions and variables', async () => {
    expect(
      await traced({
        'app.go': `${HEADER}
const Default = "gpt-4"

type Service struct {
	ai     *openai.Client
	claude anthropic.Client
}

func run(ctx context.Context, injected *openai.Client) {
	c := openai.NewClient()
	c.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: openai.ChatModelGPT4o})
	c.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: Default, Temperature: openai.Float(0)})
	c.Responses.New(ctx, responses.ResponseNewParams{Model: openai.ChatModel("o1")})
	model := os.Getenv("MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	injected.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: model})
	params := openai.ChatCompletionNewParams{Model: openai.F(openai.ChatModelGPT4)}
	params.Model = "gpt-4.1"
	c.Chat.Completions.New(ctx, params)
	c.Embeddings.New(ctx, openai.EmbeddingNewParams{Model: "text-embedding-ada-002"})
	c.Chat.Completions.New(ctx, build())
	c.Models.List(ctx)
}

func (s *Service) ask(ctx context.Context, m string) {
	s.ai.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: m})
	s.claude.Messages.New(ctx, anthropic.MessageNewParams{Model: anthropic.ModelClaude3OpusLatest, MaxTokens: 5})
	s.claude.Messages.New(ctx, anthropic.MessageNewParams{Model: anthropic.ModelUnknownFuture})
}
`,
      }),
    ).toEqual([
      'app.go:25 openai Chat.Completions.New constructor <- gpt-4o@25 (SDK constant `openai.ChatModelGPT4o`)',
      'app.go:26 openai Chat.Completions.New constructor <- gpt-4@16 (constant `Default`)',
      'app.go:27 openai Responses.New constructor <- o1@27 (literal)',
      'app.go:32 openai Chat.Completions.New parameter <- gpt-4o-mini@30 (constant `model`) stop: The model is read from the environment variable MODEL with no default in the same expression.',
      'app.go:35 openai Chat.Completions.New constructor <- gpt-4.1@34 (literal)',
      'app.go:36 openai Embeddings.New constructor <- text-embedding-ada-002@36 (literal)',
      'app.go:37 openai Chat.Completions.New constructor stop: The request params are not a struct literal Refit can read.',
      'app.go:42 openai Chat.Completions.New class-field stop: The model comes from the parameter `m`, whose callers Refit does not follow in Go.',
      'app.go:43 anthropic Messages.New class-field <- claude-3-opus-latest@43 (SDK constant `anthropic.ModelClaude3OpusLatest`)',
      'app.go:44 anthropic Messages.New class-field stop: `anthropic.ModelUnknownFuture` is not a model constant Refit knows from the SDK.',
    ]);
  });

  it('finds clients declared in another file of the package and ignores other types', async () => {
    expect(
      await traced({
        'pkg/client.go': `package pkg\n\nimport "github.com/openai/openai-go"\n\nvar Shared = openai.NewClient()\n`,
        'pkg/ask.go': `package pkg\n\nimport "example.com/llm"\n\nfunc Ask() {\n\tShared.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: "gpt-4"})\n\tother := llm.New()\n\tother.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: "gpt-4"})\n}\n`,
        'other/ask.go': `package other\n\nfunc Ask() {\n\tShared.Chat.Completions.New(ctx, nil)\n}\n`,
      }),
    ).toEqual(['pkg/ask.go:6 openai Chat.Completions.New constructor <- gpt-4@6 (literal)']);
  });

  it('reads SDK versions from go.mod and go.sum, with the Stripe API version they pin', async () => {
    const root = await repository({
      'go.mod': `module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/stripe/stripe-go/v82 v82.5.1\n\tgithub.com/openai/openai-go/v3 v3.85.1 // indirect\n)\n\nrequire github.com/stripe/stripe-go/v72 v72.0.0\n`,
      'go.sum': `github.com/stripe/stripe-go/v82 v82.5.1 h1:abc=\ngithub.com/stripe/stripe-go/v82 v82.5.1/go.mod h1:def=\n`,
      'tools/go.mod': `module example.com/tools\n\nrequire github.com/anthropics/anthropic-sdk-go v1.84.0\n`,
      'vendor/go.mod': `module vendored\n\nrequire github.com/stripe/stripe-go/v84 v84.4.1\n`,
    });
    expect(await goModules(root)).toEqual([
      {
        file: 'go.mod',
        line: 6,
        module: 'github.com/stripe/stripe-go/v82',
        version: 'v82.5.1',
        provider: 'stripe',
        locked: true,
        apiVersion: '2025-08-27.basil',
      },
      {
        file: 'go.mod',
        line: 7,
        module: 'github.com/openai/openai-go/v3',
        version: 'v3.85.1',
        provider: 'openai',
        locked: false,
        apiVersion: null,
      },
      {
        file: 'go.mod',
        line: 10,
        module: 'github.com/stripe/stripe-go/v72',
        version: 'v72.0.0',
        provider: 'stripe',
        locked: false,
        apiVersion: '2020-08-27',
      },
      {
        file: 'tools/go.mod',
        line: 3,
        module: 'github.com/anthropics/anthropic-sdk-go',
        version: 'v1.84.0',
        provider: 'anthropic',
        locked: false,
        apiVersion: null,
      },
    ]);
    const trace = await traceGoCalls(root);
    expect([trace.files, trace.calls.length, trace.modules.length]).toEqual([0, 0, 4]);
  });
});

describe('Go model deadlines', () => {
  it('classifies Go matches and reports traced requests as stops, never edits', async () => {
    const root = await repository({
      'go.mod': 'module example.com/app\n',
      'app.go': `${HEADER}
// Use "gpt-4" until the migration.
var Models = []string{"gpt-4", "gpt-4o", "o1"}
var Limits = map[string]int{"gpt-4": 8192}
var Unused = "gpt-4"

func run(ctx context.Context, model string) {
	c := openai.NewClient()
	c.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: openai.ChatModelGPT4})
	c.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: "gpt-4", Temperature: openai.Float(0)})
	c.Completions.New(ctx, openai.CompletionNewParams{Model: "text-davinci-003"})
	c.Embeddings.New(ctx, openai.EmbeddingNewParams{Model: "text-embedding-ada-002"})
	if model == "gpt-4" || strings.HasPrefix(model, "gpt-4") {
	}
	a := anthropic.NewClient()
	a.Messages.New(ctx, anthropic.MessageNewParams{Model: "claude-3-opus-latest", TopK: anthropic.Int(5)})
}
`,
      'app_test.go': `package app\n\nvar m = "gpt-4"\n`,
    });
    const scan = await scanDeadlines(root, registry, now);
    const gpt4 = scan.exposures.find((item) => item.deadline.id === 'openai-gpt-4')!;
    expect(gpt4.evidence.map((item) => item.line)).toEqual([19, 23, 24]);
    expect(gpt4.nonLive.map((item) => `${item.file}:${item.line} ${item.use}`)).toEqual([
      'app_test.go:3 test',
      'app.go:16 comment',
      'app.go:17 catalog',
      'app.go:18 catalog',
      'app.go:27 check',
    ]);
    const proposal = await proposeModelReplacements(root, registry, now);
    expect(proposal.replacements).toEqual([]);
    expect(proposal.patch).toBeNull();
    expect(proposal.stops.map((item) => `${item.line} ${item.model}: ${item.reason}`)).toEqual([
      '23 gpt-4: The model reaches this request through SDK constant `openai.ChatModelGPT4`, which Refit reports but does not edit yet; change it by hand to gpt-5.6-sol.',
      '24 gpt-4: The request sets temperature, which gpt-5.6-sol may reject or treat differently.',
      '25 text-davinci-003: The registry names no concrete replacement model ID.',
      '26 text-embedding-ada-002: `Embeddings.New` is not a call Refit edits; text-embedding-3-small may change formats or parameters; change it by hand to text-embedding-3-small.',
      '30 claude-3-opus-latest: The request sets top_k, which claude-opus-4-8 may reject or treat differently.',
    ]);
    expect(proposal.unresolved.map((item) => `${item.line} ${item.reason}`)).toEqual([
      '19 No traced request sends it as its model; it is assigned to `Unused`. Check where it is used and change it by hand if it reaches the API.',
    ]);
  });
});
