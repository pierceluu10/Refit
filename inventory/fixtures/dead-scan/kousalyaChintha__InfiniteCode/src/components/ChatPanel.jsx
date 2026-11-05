// Excerpt of kousalyaChintha/InfiniteCode, src/components/ChatPanel.jsx, seen in P5.
export default function ChatPanel({ aiSettings, prompt }) {
  const send = () =>
    fetch('https://api.anthropic.com/v1/complete', {
      method: 'POST',
      headers: { 'x-api-key': aiSettings.apiKey },
      body: JSON.stringify({ model: aiSettings.model, prompt }),
    });
  return <button onClick={send}>Send</button>;
}
