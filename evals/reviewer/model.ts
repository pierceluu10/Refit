// The reviewer's model client is injected, so tests and the smoke run use a fake and spend $0.
// A real client wraps the harness's model access and its budget ledger once that lands (O2).

export type ModelRequest = { system: string; prompt: string; maxTokens: number };
export type ModelResponse = { text: string; costUsd: number; model: string };

export type ModelClient = { complete: (request: ModelRequest) => Promise<ModelResponse> };

type Reply = string | ((request: ModelRequest) => string);

/** A scripted client: returns the given replies in order (or one reply forever). No network. */
export class FakeModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly replies: Reply[];
  private readonly costUsd: number;

  constructor(replies: Reply | Reply[], costUsd = 0) {
    this.replies = Array.isArray(replies) ? replies : [replies];
    this.costUsd = costUsd;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const index = Math.min(this.requests.length - 1, this.replies.length - 1);
    const reply = this.replies[index];
    if (reply === undefined) throw new Error('FakeModelClient has no replies');
    const text = typeof reply === 'function' ? reply(request) : reply;
    return { text, costUsd: this.costUsd, model: 'fake' };
  }
}

/** Placeholder until the harness exports its model client. Throws instead of calling an API. */
export const unwiredModelClient: ModelClient = {
  complete: async () => {
    throw new Error(
      'no real model client is wired into evals yet; pass one that charges the run ledger',
    );
  },
};
