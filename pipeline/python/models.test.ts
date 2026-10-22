import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDeadlines } from '../deadline-exposure.ts';
import type { DeadlineEntry, DeadlineRegistry } from '../deadline-registry.ts';
import { proposeModelReplacements } from '../model-retirements.ts';
import { tracePythonModelCalls, traceFiles } from './models.ts';
import { GRAMMAR, GRAMMAR_SHA256 } from './syntax.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-python-models-'));
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
      versions: ['claude-3-opus-20240229'],
      replacement: 'claude-opus-4-8',
    }),
    entry({
      id: 'gemini-flash',
      provider: 'gemini',
      versions: ['gemini-1.5-flash'],
      replacement: 'gemini-2.5-flash',
    }),
  ],
};
const now = new Date('2026-10-22T00:00:00Z');

// Each traced call as `file:line provider resource.method <- literal@line (via)`, or its stop.
async function traced(files: Record<string, string>) {
  const calls = await traceFiles(
    Object.entries(files).map(([path, content]) => ({ path, content })),
  );
  return calls.map((call) => {
    const model = call.arguments.model;
    return [
      `${call.file}:${call.line} ${call.provider} ${call.resource}.${call.method} ${call.client.kind}`,
      ...model.literals.map((item) => `<- ${item.value}@${item.file}:${item.line} (${item.via})`),
      ...(model.stop ? [`stop: ${model.stop}`] : []),
      ...(call.client.custom ? [`custom: ${call.client.custom}`] : []),
      ...(call.spread ? ['spread'] : []),
    ].join(' ');
  });
}

describe('the vendored grammar', () => {
  it('is the published tree-sitter-python 0.25.0 build', async () => {
    const digest = createHash('sha256')
      .update(await readFile(GRAMMAR))
      .digest('hex');
    expect(digest).toBe(GRAMMAR_SHA256);
  });
});

describe('tracing Python model calls', () => {
  it('traces OpenAI clients: constructor, async, module-level, legacy module and wrappers', async () => {
    expect(
      await traced({
        'app.py': `import openai
from openai import OpenAI, AsyncOpenAI as Async

client = OpenAI()
aclient = Async()

client.chat.completions.create(model="gpt-4", messages=[])
await aclient.responses.create(model="gpt-4o", input="x")
openai.chat.completions.create(model="gpt-4", messages=[])
openai.ChatCompletion.create(model="gpt-3.5-turbo", messages=[])
client.with_options(timeout=5).chat.completions.create(model="gpt-4", messages=[])
client.chat.completions.with_raw_response.create(model="gpt-4", messages=[])
client.beta.chat.completions.parse(model="gpt-4o", messages=[])
openai.OpenAI().chat.completions.create(model="o1", messages=[])
client.files.list()
`,
      }),
    ).toEqual([
      'app.py:7 openai chat.completions.create constructor <- gpt-4@app.py:7 (literal)',
      'app.py:8 openai responses.create constructor <- gpt-4o@app.py:8 (literal)',
      'app.py:9 openai chat.completions.create module <- gpt-4@app.py:9 (literal)',
      'app.py:10 openai ChatCompletion.create module <- gpt-3.5-turbo@app.py:10 (literal)',
      'app.py:11 openai chat.completions.create constructor <- gpt-4@app.py:11 (literal)',
      'app.py:12 openai chat.completions.create constructor <- gpt-4@app.py:12 (literal)',
      'app.py:13 openai beta.chat.completions.parse constructor <- gpt-4o@app.py:13 (literal)',
      'app.py:14 openai chat.completions.create constructor <- o1@app.py:14 (literal)',
    ]);
  });

  it('traces Anthropic and google-genai clients, sync and async', async () => {
    expect(
      await traced({
        'claude.py': `import anthropic
from anthropic import AsyncAnthropic
sync = anthropic.Anthropic()
async_client = AsyncAnthropic()
sync.messages.create(model="claude-3-opus-20240229", max_tokens=5, messages=[])
async with async_client.messages.stream(model="claude-3-opus-20240229", max_tokens=5, messages=[]) as s:
    pass
sync.messages.count_tokens(model="claude-3-opus-20240229", messages=[])
`,
        'gemini.py': `from google import genai
import google.genai as g2
client = genai.Client()
other = g2.Client(api_key="k")
client.models.generate_content(model="gemini-1.5-flash", contents="x")
await client.aio.models.generate_content(model="models/gemini-1.5-flash", contents="x")
chat = other.chats.create(model="gemini-2.0-flash")
chat.send_message("hi")
`,
      }),
    ).toEqual([
      'claude.py:5 anthropic messages.create constructor <- claude-3-opus-20240229@claude.py:5 (literal)',
      'claude.py:6 anthropic messages.stream constructor <- claude-3-opus-20240229@claude.py:6 (literal)',
      'claude.py:8 anthropic messages.count_tokens constructor <- claude-3-opus-20240229@claude.py:8 (literal)',
      'gemini.py:5 gemini models.generate_content constructor <- gemini-1.5-flash@gemini.py:5 (literal)',
      'gemini.py:6 gemini aio.models.generate_content constructor <- models/gemini-1.5-flash@gemini.py:6 (literal)',
      'gemini.py:7 gemini chats.create constructor <- gemini-2.0-flash@gemini.py:7 (literal)',
    ]);
  });

  it('traces class-held, annotated, parameter and imported clients', async () => {
    expect(
      await traced({
        'pkg/clients.py': `from openai import OpenAI\nshared = OpenAI()\n`,
        'pkg/service.py': `from typing import Optional
from anthropic import Anthropic
from openai import OpenAI
from .clients import shared
from pkg import clients

class Service:
    client: Anthropic

    def __init__(self):
        self.openai = OpenAI()
        self.lazy = None

    def connect(self):
        self.lazy = OpenAI()

    def run(self):
        self.openai.chat.completions.create(model="gpt-4", messages=[])
        self.client.messages.create(model="claude-3-opus-20240229", max_tokens=1, messages=[])
        self.lazy.chat.completions.create(model="gpt-4", messages=[])

def helper(client: Optional[OpenAI], untyped):
    client.chat.completions.create(model="gpt-4", messages=[])
    untyped.chat.completions.create(model="gpt-4", messages=[])

shared.chat.completions.create(model="gpt-4", messages=[])
clients.shared.chat.completions.create(model="gpt-4", messages=[])
`,
      }),
    ).toEqual([
      'pkg/service.py:18 openai chat.completions.create constructor <- gpt-4@pkg/service.py:18 (literal)',
      'pkg/service.py:19 anthropic messages.create class-field <- claude-3-opus-20240229@pkg/service.py:19 (literal)',
      'pkg/service.py:20 openai chat.completions.create constructor <- gpt-4@pkg/service.py:20 (literal)',
      'pkg/service.py:23 openai chat.completions.create parameter <- gpt-4@pkg/service.py:23 (literal)',
      'pkg/service.py:26 openai chat.completions.create constructor <- gpt-4@pkg/service.py:26 (literal)',
      'pkg/service.py:27 openai chat.completions.create constructor <- gpt-4@pkg/service.py:27 (literal)',
    ]);
  });

  it('follows constants, environment defaults, fallbacks, fields, entries, defaults and callers', async () => {
    expect(
      await traced({
        'config.py': `import os\nDEFAULT_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4")\n`,
        'app.py': `import os
from os import getenv
from openai import OpenAI
from config import DEFAULT_MODEL
import config

client = OpenAI()
MODEL = "gpt-4"
MODELS = {"fast": "gpt-4o-mini", "smart": "gpt-4"}

class Settings:
    model_name: str = "gpt-4-turbo"

settings = Settings()

class Bot:
    model = "gpt-4"

    def __init__(self, model="gpt-4o"):
        self.model = model

    def run(self):
        client.chat.completions.create(model=self.model, messages=[])

def ask(model: str = "gpt-4"):
    client.chat.completions.create(model=model, messages=[])

ask(model="o1")
ask()
Bot("o3")
client.chat.completions.create(model=MODEL, messages=[])
client.chat.completions.create(model=DEFAULT_MODEL, messages=[])
client.chat.completions.create(model=config.DEFAULT_MODEL, messages=[])
client.chat.completions.create(model=os.getenv("M") or "gpt-4", messages=[])
client.chat.completions.create(model=getenv("M", "gpt-4"), messages=[])
client.chat.completions.create(model="gpt-4" if fast else "gpt-4o", messages=[])
client.chat.completions.create(model=MODELS["smart"], messages=[])
client.chat.completions.create(model=settings.model_name, messages=[])
`,
      }),
    ).toEqual([
      'app.py:23 openai chat.completions.create constructor <- gpt-4@app.py:17 (class field `self.model`) <- o3@app.py:30 (argument for `model`)',
      'app.py:26 openai chat.completions.create constructor <- gpt-4@app.py:25 (parameter default `model`) <- o1@app.py:28 (argument for `model`)',
      'app.py:31 openai chat.completions.create constructor <- gpt-4@app.py:8 (constant `MODEL`)',
      'app.py:32 openai chat.completions.create constructor <- gpt-4@config.py:2 (environment default (OPENAI_MODEL))',
      'app.py:33 openai chat.completions.create constructor <- gpt-4@config.py:2 (environment default (OPENAI_MODEL))',
      'app.py:34 openai chat.completions.create constructor <- gpt-4@app.py:34 (literal) stop: The model is read from the environment variable M with no default.',
      'app.py:35 openai chat.completions.create constructor <- gpt-4@app.py:35 (environment default (M))',
      'app.py:36 openai chat.completions.create constructor <- gpt-4@app.py:36 (literal) <- gpt-4o@app.py:36 (literal)',
      'app.py:37 openai chat.completions.create constructor <- gpt-4@app.py:9 (entry `smart`)',
      'app.py:38 openai chat.completions.create constructor <- gpt-4-turbo@app.py:12 (class field `settings.model_name`)',
    ]);
  });

  it('follows client factories, client defaults, mapping and command-line defaults', async () => {
    expect(
      await traced({
        'app.py': `import argparse
from openai import OpenAI, AsyncOpenAI

def get_client(fast=False):
    if fast:
        return AsyncOpenAI()
    return OpenAI()

def maybe_client():
    return None

shared = OpenAI()

def summarize(text, client=shared, model="gpt-4"):
    return client.chat.completions.create(model=model, messages=[])

def run(config):
    client = get_client()
    client.chat.completions.create(model=config.get("model", "gpt-4o"), messages=[])

def overwrite(model="gpt-4"):
    model = "o1"
    get_client().chat.completions.create(model=model, messages=[])

class Service:
    def _client(self):
        return OpenAI()

    def model(self):
        return "o3"

    def run(self):
        self._client().chat.completions.create(model=self.model(), messages=[])

parser = argparse.ArgumentParser()
parser.add_argument("--model", default="gpt-4o-mini")
parser.add_argument("--judge-model", dest="judge")
args = parser.parse_args()
shared.chat.completions.create(model=args.model, messages=[])
shared.chat.completions.create(model=args.judge, messages=[])
CONFIG = {"model": "gpt-4.1"}
shared.chat.completions.create(model=CONFIG.get("model"), messages=[])
shared.chat.completions.create(model="", messages=[])
`,
      }),
    ).toEqual([
      'app.py:15 openai chat.completions.create constructor <- gpt-4@app.py:14 (parameter default `model`)',
      'app.py:19 openai chat.completions.create constructor <- gpt-4o@app.py:19 (default of `config.get("model")`)',
      'app.py:23 openai chat.completions.create constructor <- o1@app.py:22 (constant `model`)',
      'app.py:33 openai chat.completions.create constructor <- o3@app.py:30 (literal)',
      'app.py:39 openai chat.completions.create constructor <- gpt-4o-mini@app.py:36 (command-line default (--model))',
      'app.py:40 openai chat.completions.create constructor stop: The model comes from the command-line option for `judge`, which has no default.',
      'app.py:42 openai chat.completions.create constructor <- gpt-4.1@app.py:41 (entry `model`)',
      'app.py:43 openai chat.completions.create constructor',
    ]);
  });

  it('follows self into nested functions, callers in other files and keys after a spread', async () => {
    expect(
      await traced({
        'pkg/embed.py': `from google import genai
async def embed(client: genai.Client, texts, model="gemini-embedding-001"):
    return await client.aio.models.embed_content(model=model, contents=texts)

def query(client: genai.Client, model="gemini-2.0-flash"):
    return client.models.generate_content(model=model, contents="x")
`,
        'pkg/tools.py': `from pkg.embed import embed, query
from pkg import embed as embedding
async def run(client):
    await embed(client, ["a"], "text-embedding-004")
    query(client)
    embedding.query(client, model="gemini-2.5-pro")
`,
        'pkg/model.py': `from anthropic import Anthropic
class Model:
    def __init__(self, model="claude-sonnet-4-6"):
        self.model = model
        self.client = Anthropic()

    def query(self, sampling):
        kwargs = {**sampling, "model": self.model, "max_tokens": 5}

        def call():
            return self.client.messages.create(**kwargs)

        return call()
`,
        'main.py': `from pkg.model import Model\nModel("claude-opus-4-8")\n`,
      }),
    ).toEqual([
      'pkg/embed.py:3 gemini aio.models.embed_content parameter <- text-embedding-004@pkg/tools.py:4 (argument for `model`)',
      'pkg/embed.py:6 gemini models.generate_content parameter <- gemini-2.0-flash@pkg/embed.py:5 (parameter default `model`) <- gemini-2.5-pro@pkg/tools.py:6 (argument for `model`)',
      'pkg/model.py:11 anthropic messages.create constructor <- claude-opus-4-8@main.py:2 (argument for `model`) spread',
    ]);
  });

  it('reports LangChain chat models by class, with their model arguments', async () => {
    expect(
      await traced({
        'chains.py': `import os
import langchain_openai
from langchain_openai import ChatOpenAI, AzureChatOpenAI
from langchain_anthropic import ChatAnthropic
from langchain_community.chat_models import ChatOpenAI as LegacyChat
from mylib import ChatOpenAI as Other

fast = ChatOpenAI(model="gpt-4o-mini", temperature=0)
smart = ChatAnthropic(model_name=os.getenv("CLAUDE", "claude-3-opus-20240229"))
azure = AzureChatOpenAI(model="gpt-4", azure_endpoint="https://x")
local = langchain_openai.ChatOpenAI(model="llama3", base_url="http://localhost:11434/v1")
legacy = LegacyChat(model_name="gpt-3.5-turbo")
other = Other(model="gpt-4")
default = ChatOpenAI()
`,
      }),
    ).toEqual([
      'chains.py:8 openai langchain.ChatOpenAI constructor <- gpt-4o-mini@chains.py:8 (literal)',
      'chains.py:9 anthropic langchain.ChatAnthropic constructor <- claude-3-opus-20240229@chains.py:9 (environment default (CLAUDE))',
      'chains.py:10 openai langchain.AzureChatOpenAI constructor <- gpt-4@chains.py:10 (literal) custom: Azure OpenAI',
      'chains.py:11 openai langchain.ChatOpenAI constructor <- llama3@chains.py:11 (literal) custom: a custom base URL',
      'chains.py:12 openai langchain.ChatOpenAI constructor <- gpt-3.5-turbo@chains.py:12 (literal)',
    ]);
    const calls = await traceFiles([
      {
        path: 'a.py',
        content:
          'from langchain_community.chat_models import ChatOpenAI\nChatOpenAI(model="gpt-4")\n',
      },
    ]);
    expect(calls.map((call) => call.package)).toEqual(['langchain-community']);
  });

  it('ignores assignments after the use unless a loop holds both', async () => {
    expect(
      await traced({
        'app.py': `from openai import OpenAI
client = OpenAI()
def run(name):
    if name == "openai":
        model = "gpt-4o"
        return client.chat.completions.create(model=model, messages=[])
    if name == "local":
        model = "llama3.2"
        return None
    for attempt in range(3):
        if attempt:
            client.chat.completions.create(model=retry, messages=[])
        retry = "gpt-4o-mini"
`,
      }),
    ).toEqual([
      'app.py:6 openai chat.completions.create constructor <- gpt-4o@app.py:5 (constant `model`)',
      'app.py:12 openai chat.completions.create constructor <- gpt-4o-mini@app.py:13 (constant `retry`)',
    ]);
  });

  it('traces the return of a helper with the arguments of each call, and pydantic field defaults', async () => {
    expect(
      await traced({
        'app.py': `import os
from pydantic import BaseModel, Field
from openai import OpenAI

def first(*names, default=""):
    for name in names:
        if os.environ.get(name):
            return os.environ[name]
    return default

class Settings(BaseModel):
    model: str = Field(default="gpt-4.1")

settings = Settings()
client = OpenAI()
url = first("BASE_URL", default="http://localhost:11434")
client.chat.completions.create(model=first("MODEL", "LLM_MODEL", default="gpt-4o-mini"), messages=[])
client.chat.completions.create(model=settings.model, messages=[])
`,
      }),
    ).toEqual([
      'app.py:17 openai chat.completions.create constructor <- gpt-4o-mini@app.py:17 (argument for `default`) stop: The model is read from the environment variable name with no default.',
      'app.py:18 openai chat.completions.create constructor <- gpt-4.1@app.py:12 (class field `settings.model`)',
    ]);
  });

  it('reads the model from a spread dictionary and stops on what it cannot trace', async () => {
    expect(
      await traced({
        'app.py': `import os
from openai import OpenAI
from somewhere import REMOTE
client = OpenAI()
params = {"model": "gpt-4", "messages": []}
client.chat.completions.create(**params)
client.chat.completions.create(**dict(model="gpt-4", temperature=0))
client.chat.completions.create(**kwargs)
client.chat.completions.create(model=os.environ["MODEL"], messages=[])
client.chat.completions.create(model=settings.MODEL, messages=[])
client.chat.completions.create(model=pick(), messages=[])
client.chat.completions.create(model=f"gpt-{version}", messages=[])
client.chat.completions.create(model="gpt-" + "4", messages=[])
client.chat.completions.create(model=REMOTE, messages=[])
a, b = "gpt-4", "x"
client.chat.completions.create(model=a, messages=[])
def run(model):
    client.chat.completions.create(model=model, messages=[])
def forward(*args):
    run(*args)
def lonely(model):
    client.chat.completions.create(model=model, messages=[])
`,
      }),
    ).toEqual([
      'app.py:6 openai chat.completions.create constructor <- gpt-4@app.py:5 (literal)',
      'app.py:7 openai chat.completions.create constructor <- gpt-4@app.py:7 (literal)',
      'app.py:8 openai chat.completions.create constructor stop: The request passes its options with `**kwargs`, which Refit cannot trace. spread',
      'app.py:9 openai chat.completions.create constructor stop: The model is read from the environment variable MODEL with no default.',
      'app.py:10 openai chat.completions.create constructor stop: The model comes from `settings.MODEL`, which Refit cannot trace.',
      'app.py:11 openai chat.completions.create constructor stop: The model comes from `pick()`, which Refit cannot trace.',
      'app.py:12 openai chat.completions.create constructor stop: The model is built from `f"gpt-{version}"`, which Refit cannot trace.',
      'app.py:13 openai chat.completions.create constructor stop: The model is built from `"gpt-" + "4"`, which Refit cannot trace.',
      'app.py:14 openai chat.completions.create constructor stop: The model is imported from `somewhere`, which is not a file in this repository.',
      'app.py:16 openai chat.completions.create constructor stop: The model comes from `a`, which is reassigned or unpacked where Refit cannot trace it.',
      'app.py:18 openai chat.completions.create constructor stop: A caller passes `model` through unpacked arguments, which Refit cannot trace.',
      'app.py:22 openai chat.completions.create constructor stop: The model comes from the parameter `model`, and no caller Refit found passes it.',
    ]);
  });

  it('stops at the depth limit and on fields declared without a value', async () => {
    const chain = Array.from({ length: 12 }, (_, index) => `M${index} = M${index + 1}`).join('\n');
    expect(
      await traced({
        'app.py': `from openai import OpenAI
client = OpenAI()
${chain}
M12 = "gpt-4"
class Bot:
    model: str
    def run(self):
        client.chat.completions.create(model=self.model, messages=[])
client.chat.completions.create(model=M0, messages=[])
`,
      }),
    ).toEqual([
      'app.py:19 openai chat.completions.create constructor stop: The model comes from the field `self.model`, which has no value.',
      'app.py:20 openai chat.completions.create constructor stop: Tracing this model stopped at the depth limit of 8.',
    ]);
  });

  it('records custom endpoints and platforms on the client', async () => {
    expect(
      await traced({
        'app.py': `import openai
from openai import OpenAI, AzureOpenAI
from anthropic import AnthropicBedrock
local = OpenAI(base_url="http://localhost:11434/v1")
azure = AzureOpenAI(azure_endpoint="https://x.openai.azure.com")
bedrock = AnthropicBedrock()
local.chat.completions.create(model="gpt-4", messages=[])
azure.chat.completions.create(model="gpt-4", messages=[])
bedrock.messages.create(model="claude-3-opus-20240229", max_tokens=1, messages=[])
local.with_options(base_url="http://x").chat.completions.create(model="gpt-4", messages=[])
`,
        'setup.py': `import openai\nopenai.api_base = "http://proxy"\nopenai.ChatCompletion.create(model="gpt-4", messages=[])\n`,
      }),
    ).toEqual([
      'app.py:7 openai chat.completions.create constructor <- gpt-4@app.py:7 (literal) custom: a custom base URL',
      'app.py:8 openai chat.completions.create constructor <- gpt-4@app.py:8 (literal) custom: Azure OpenAI',
      'app.py:9 anthropic messages.create constructor <- claude-3-opus-20240229@app.py:9 (literal) custom: Amazon Bedrock',
      'app.py:10 openai chat.completions.create constructor <- gpt-4@app.py:10 (literal) custom: a custom base URL',
      'setup.py:3 openai ChatCompletion.create module <- gpt-4@setup.py:3 (literal) custom: a custom base URL',
    ]);
  });

  it('ignores calls on objects it cannot prove are SDK clients', async () => {
    expect(
      await traced({
        'app.py': `from openai import OpenAI
from mylib import LLM
client = LLM()
client.chat.completions.create(model="gpt-4", messages=[])
def run(client):
    client.chat.completions.create(model="gpt-4", messages=[])
other = OpenAI() if fast else LLM()
other.chat.completions.create(model="gpt-4", messages=[])
`,
      }),
    ).toEqual([]);
  });

  it('reads Python files from disk, skipping virtual environments', async () => {
    const root = await repository({
      'app.py': `from openai import OpenAI\nOpenAI().chat.completions.create(model="gpt-4", messages=[])\n`,
      '.venv/lib/site.py': `from openai import OpenAI\nOpenAI().chat.completions.create(model="gpt-4", messages=[])\n`,
    });
    const trace = await tracePythonModelCalls(root);
    expect(trace.files).toBe(1);
    expect(trace.calls.map((call) => call.file)).toEqual(['app.py']);
  });
});

describe('Python model deadlines', () => {
  it('classifies every match the way the TypeScript matcher does', async () => {
    const root = await repository({
      'app/models.py': `from enum import Enum
from typing import Literal
import tiktoken
"""Uses 'gpt-4' by default."""
# Switch from "gpt-4" soon
LIVE = "gpt-4"
PRICES = {"gpt-4": 0.03}
cost = PRICES["gpt-4"]
Choice = Literal["gpt-4", "gpt-4o"]
CATALOG = ["gpt-4", "gpt-4o", "o1"]
SUPPORTED = {"gpt-4"}
FROZEN = frozenset(["gpt-4"])
RECORD = {"id": "gpt-4", "context_window": 8192}
VARIANTS = {"first": "claude-3-opus-20240229", "bedrock": "anthropic.claude-3-opus-20240229-v1:0"}
class Models(str, Enum):
    A = "gpt-4"
    B = "gpt-4o"
    C = "o1"
enc = tiktoken.encoding_for_model("gpt-4")
if model == "gpt-4" or model.startswith("gpt-4") or model in ("gpt-4", "o1"):
    pass
match model:
    case "gpt-4":
        pass
error = "The model 'gpt-4' is not available"
setting = "model: 'gpt-4'"
`,
      'tests/test_app.py': `MODEL = "gpt-4"\n`,
    });
    const scan = await scanDeadlines(root, registry, now);
    const gpt4 = [...scan.exposures, ...scan.mentions].find(
      (item) => item.deadline.id === 'openai-gpt-4',
    )!;
    expect(gpt4.evidence.map((item) => `${item.file}:${item.line}`)).toEqual([
      'app/models.py:6',
      'app/models.py:26',
    ]);
    expect(gpt4.nonLive.map((item) => `${item.line} ${item.use}`)).toEqual([
      '4 comment',
      '5 comment',
      '7 catalog',
      '8 catalog',
      '9 catalog',
      '10 catalog',
      '11 catalog',
      '12 catalog',
      '13 catalog',
      '16 catalog',
      '19 tokenizer',
      '20 check',
      '23 check',
      '25 comment',
      '1 test',
    ]);
    const opus = scan.mentions.find((item) => item.deadline.id === 'anthropic-opus')!;
    expect(opus.nonLive.map((item) => `${item.line} ${item.use}`)).toEqual(['14 catalog']);
  });

  it('reports Python requests as stops with the TypeScript reasons, never as edits', async () => {
    const root = await repository({
      'app.py': `import os
from openai import OpenAI, AzureOpenAI
from anthropic import Anthropic, AnthropicVertex
from google import genai

client = OpenAI()
azure = AzureOpenAI()
vertex = AnthropicVertex()
claude = Anthropic()
gemini = genai.Client()
MODEL = os.getenv("OPENAI_MODEL", "gpt-4")

client.chat.completions.create(model="gpt-4", messages=[])
client.chat.completions.create(model="gpt-4", temperature=0.2, messages=[])
client.chat.completions.create(**{"model": "gpt-4"}, **extra)
client.completions.create(model="text-davinci-003", prompt="x")
client.embeddings.create(model="text-embedding-ada-002", input="x")
azure.chat.completions.create(model="gpt-4", messages=[])
vertex.messages.create(model="claude-3-opus-20240229", max_tokens=1, messages=[])
client.chat.completions.create(model=MODEL, messages=[])
client.chat.completions.create(model=os.environ["M"] or "gpt-4", messages=[])
claude.messages.create(model="claude-3-opus-20240229", max_tokens=1, messages=[])
gemini.models.generate_content(model="gemini-1.5-flash", contents="x")
UNUSED = "gpt-4"
`,
      'chain.py': `from langchain_openai import ChatOpenAI\nllm = ChatOpenAI(model="gpt-4")\n`,
      'tests/test_app.py': `from openai import OpenAI\nOpenAI().chat.completions.create(model="gpt-4", messages=[])\n`,
    });
    const proposal = await proposeModelReplacements(root, registry, now);
    expect(proposal.replacements).toEqual([]);
    expect(proposal.patch).toBeNull();
    expect(
      proposal.stops.map((item) => `${item.line} ${item.at.line} ${item.model}: ${item.reason}`),
    ).toEqual([
      '13 13 gpt-4: Refit reports Python requests but does not edit Python code yet; change it by hand to gpt-5.6-sol.',
      '14 14 gpt-4: The request sets temperature, which gpt-5.6-sol may reject or treat differently.',
      '15 15 gpt-4: The request spreads other options, which may set parameters the replacement rejects.',
      '16 16 text-davinci-003: The registry names no concrete replacement model ID.',
      '17 17 text-embedding-ada-002: `embeddings.create` is not a call Refit edits; text-embedding-3-small may change formats or parameters; change it by hand to text-embedding-3-small.',
      "18 18 gpt-4: The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to gpt-5.6-sol.",
      '19 19 claude-3-opus-20240229: The client is set up for Vertex AI, so the model may name a platform model ID; change it by hand to claude-opus-4-8.',
      '20 11 gpt-4: The model reaches this request through environment default (OPENAI_MODEL), which Refit reports but does not edit yet; change it by hand to gpt-5.6-sol.',
      '21 21 gpt-4: The model is read from the environment variable M with no default. Change it by hand to gpt-5.6-sol.',
      '22 22 claude-3-opus-20240229: Refit reports Python requests but does not edit Python code yet; change it by hand to claude-opus-4-8.',
      '23 23 gemini-1.5-flash: Gemini is report only, so Refit never edits its models; change it by hand to gemini-2.5-flash.',
      '2 2 gpt-4: `ChatOpenAI` is a LangChain chat model, which Refit reports but does not edit; change it by hand to gpt-5.6-sol.',
    ]);
    expect(proposal.unresolved.map((item) => `${item.file}:${item.line} ${item.reason}`)).toEqual([
      'app.py:24 No traced request sends it as its model; it is assigned to `UNUSED`. Check where it is used and change it by hand if it reaches the API.',
    ]);
  });

  it('says when no Python file imports the SDK', async () => {
    const root = await repository({
      'app.py': `from litellm import completion\ncompletion(model="gpt-4", messages=[])\n`,
    });
    const proposal = await proposeModelReplacements(root, registry, now);
    expect(proposal.unresolved.map((item) => item.reason)).toEqual([
      'No Python file imports the `openai` package, so the model may reach the API through another library or a wrapper (it is the `model` argument of completion()). Check where it is used and change it by hand if it reaches the API.',
    ]);
  });
});
