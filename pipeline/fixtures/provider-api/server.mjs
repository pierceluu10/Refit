import { createServer } from 'node:http';

const OPENAI_ERROR_SOURCE = 'https://github.com/openai/openai-node/blob/v7.32.0/src/core/error.ts';
const ANTHROPIC_ERROR_SOURCE =
  'https://github.com/anthropics/anthropic-sdk-typescript/blob/sdk-v0.71.2/src/core/error.ts';

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function openAIModelNotFound(model) {
  // OpenAI's SDK maps this 404 error envelope to NotFoundError. Shape checked
  // against OPENAI_ERROR_SOURCE.
  return {
    error: {
      message: `The model \`${model}\` does not exist or you do not have access to it.`,
      type: 'invalid_request_error',
      param: null,
      code: 'model_not_found',
    },
  };
}

function anthropicModelNotFound(model) {
  // Anthropic's SDK maps this 404 envelope to NotFoundError. Shape checked
  // against ANTHROPIC_ERROR_SOURCE.
  return {
    type: 'error',
    error: {
      type: 'not_found_error',
      message: `Model not found: ${model}`,
    },
    request_id: 'req_refit_fixture',
  };
}

function completionResponse(model) {
  return {
    id: 'cmpl_refit_fixture',
    object: 'text_completion',
    created: 0,
    model,
    choices: [{ text: 'fixture completion', index: 0, logprobs: null, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
}

function chatCompletionResponse(model) {
  return {
    id: 'chatcmpl_refit_fixture',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'fixture completion', refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
}

function messageResponse(model) {
  return {
    id: 'msg_refit_fixture',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'fixture message' }],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createFakeProviderServer({ retiredModelIds = [] } = {}) {
  const retiredModels = new Set(retiredModelIds);
  const requests = [];

  const server = createServer(async (request, response) => {
    let body;
    try {
      body = await readJson(request);
    } catch {
      sendJson(response, 400, {
        error: { message: 'Invalid JSON request body.', type: 'invalid_request_error' },
      });
      return;
    }

    requests.push({
      method: request.method,
      path: request.url,
      body,
    });

    if (request.method !== 'POST') {
      sendJson(response, 405, {
        error: { message: 'Method not allowed.', type: 'invalid_request_error' },
      });
      return;
    }

    const model = body?.model;
    if (typeof model !== 'string') {
      sendJson(response, 400, {
        error: {
          message: "Missing required parameter: 'model'.",
          type: 'invalid_request_error',
          param: 'model',
          code: null,
        },
      });
      return;
    }

    if (request.url === '/v1/messages') {
      if (retiredModels.has(model)) {
        sendJson(response, 404, anthropicModelNotFound(model));
        return;
      }
      sendJson(response, 200, messageResponse(model));
      return;
    }

    if (request.url === '/v1/completions' || request.url === '/v1/chat/completions') {
      if (retiredModels.has(model)) {
        sendJson(response, 404, openAIModelNotFound(model));
        return;
      }
      sendJson(
        response,
        200,
        request.url === '/v1/completions'
          ? completionResponse(model)
          : chatCompletionResponse(model),
      );
      return;
    }

    sendJson(response, 404, {
      error: {
        message: `Unknown fixture route: ${request.url}`,
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    });
  });

  return {
    requests,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected a loopback TCP address.');
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export const errorShapeSources = {
  openai: OPENAI_ERROR_SOURCE,
  anthropic: ANTHROPIC_ERROR_SOURCE,
};
