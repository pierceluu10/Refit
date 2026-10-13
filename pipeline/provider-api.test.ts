import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error The reusable fixture is intentionally executable plain JavaScript.
import { createFakeProviderServer } from './fixtures/provider-api/server.mjs';

const execute = promisify(execFile);
const roots: string[] = [];
const fixture = resolve('pipeline/fixtures/openai-completions');
const retiredModel = 'fixture-openai-retired-model';
const INSTALL_TIMEOUT_MS = 120_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function post(baseURL: string, path: string, body: object) {
  const response = await fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('loopback fake provider API', () => {
  it('returns minimal valid OpenAI and Anthropic responses and logs exact models', async () => {
    const provider = createFakeProviderServer();
    const baseURL = await provider.listen();
    try {
      const completion = await post(baseURL, '/v1/completions', {
        model: 'live-completion-model',
        prompt: 'hello',
      });
      const chat = await post(baseURL, '/v1/chat/completions', {
        model: 'live-chat-model',
        messages: [{ role: 'user', content: 'hello' }],
      });
      const message = await post(baseURL, '/v1/messages', {
        model: 'live-anthropic-model',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(completion).toMatchObject({
        status: 200,
        body: {
          object: 'text_completion',
          model: 'live-completion-model',
          choices: [{ text: 'fixture completion', finish_reason: 'stop' }],
        },
      });
      expect(chat).toMatchObject({
        status: 200,
        body: {
          object: 'chat.completion',
          model: 'live-chat-model',
          choices: [{ message: { role: 'assistant', content: 'fixture completion' } }],
        },
      });
      expect(message).toMatchObject({
        status: 200,
        body: {
          type: 'message',
          role: 'assistant',
          model: 'live-anthropic-model',
          content: [{ type: 'text', text: 'fixture message' }],
        },
      });
      expect(
        provider.requests.map((request: { body: { model: string } }) => request.body.model),
      ).toEqual(['live-completion-model', 'live-chat-model', 'live-anthropic-model']);
    } finally {
      await provider.close();
    }
  });

  it('returns provider-specific 404 errors for configured retired models', async () => {
    const provider = createFakeProviderServer({ retiredModelIds: [retiredModel] });
    const baseURL = await provider.listen();
    try {
      expect(
        await post(baseURL, '/v1/completions', { model: retiredModel, prompt: 'hello' }),
      ).toEqual({
        status: 404,
        body: {
          error: {
            message: `The model \`${retiredModel}\` does not exist or you do not have access to it.`,
            type: 'invalid_request_error',
            param: null,
            code: 'model_not_found',
          },
        },
      });
      expect(
        await post(baseURL, '/v1/chat/completions', {
          model: retiredModel,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      ).toEqual({
        status: 404,
        body: {
          error: {
            message: `The model \`${retiredModel}\` does not exist or you do not have access to it.`,
            type: 'invalid_request_error',
            param: null,
            code: 'model_not_found',
          },
        },
      });
      expect(
        await post(baseURL, '/v1/messages', {
          model: retiredModel,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      ).toEqual({
        status: 404,
        body: {
          type: 'error',
          error: { type: 'not_found_error', message: `Model not found: ${retiredModel}` },
          request_id: 'req_refit_fixture',
        },
      });
      expect(provider.requests).toHaveLength(3);
    } finally {
      await provider.close();
    }
  });
});

it.skipIf(!process.env.REFIT_OPENAI_SDK)(
  'runs direct, relative-wrapper, and variable model calls through the real OpenAI SDK',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-openai-completions-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await cp(join(fixture, 'repository'), repository, { recursive: true });
    await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: repository,
      timeout: INSTALL_TIMEOUT_MS,
    });
    expect(
      JSON.parse(await readFile(join(repository, 'node_modules/openai/package.json'), 'utf8'))
        .version,
    ).toBe('7.32.0');

    const harness = join(fixture, 'contract.mjs');
    const live = JSON.parse(
      (await execute(process.execPath, [harness, repository, 'live'])).stdout,
    );
    expect(live.results).toEqual([
      'fixture completion',
      'fixture completion',
      'fixture completion',
    ]);
    expect(live.requests).toHaveLength(3);
    expect(live.requests.map((request: { body: { model: string } }) => request.body.model)).toEqual(
      [retiredModel, retiredModel, retiredModel],
    );

    await expect(execute(process.execPath, [harness, repository, 'retired'])).rejects.toMatchObject(
      {
        code: 1,
        stderr: expect.stringContaining('"status":404,"code":"model_not_found"'),
      },
    );
  },
  180_000,
);
