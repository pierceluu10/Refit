// Excerpt of hachanimohamedsaid/backend_AgentAi at 387ace95142d, src/realtime/realtime-voice.service.ts.
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export const connect = (apiKey: string) =>
  new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  } as WebSocket.ClientOptions);
