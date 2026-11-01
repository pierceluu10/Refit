// A fake model for tests and smoke runs: each call plays the next scripted turn through the real tools.
import type { AgentSession, SessionInput } from './types.ts';

export type ScriptedTurn = (
  call: (tool: string, args: Record<string, unknown>) => Promise<string>,
  input: SessionInput,
) => Promise<void>;

export function scriptedSession(turns: ScriptedTurn[], costPerCallUsd = 0.01): AgentSession {
  let index = 0;
  return async (input) => {
    input.ledger.assertCanSpend();
    input.ledger.charge({
      model: input.model,
      costUsd: costPerCallUsd,
      note: `fake turn ${index}`,
    });
    const turn = turns[Math.min(index++, turns.length - 1)];
    const call = async (name: string, args: Record<string, unknown>) => {
      const found = input.tools.find((candidate) => candidate.name === name);
      if (!found) return `error: no tool named ${name}`;
      const output = await found.run(args, { repoDir: input.sandbox.dir });
      input.log({ type: 'fake-tool', name, args, output });
      return output;
    };
    await turn(call, input);
    return { sessionId: 'fake-session', finalText: `fake turn ${index}`, stopReason: 'done' };
  };
}
