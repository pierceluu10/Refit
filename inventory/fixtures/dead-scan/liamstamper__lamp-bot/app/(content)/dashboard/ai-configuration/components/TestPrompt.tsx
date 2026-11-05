// Excerpt of liamstamper/lamp-bot, app/(content)/dashboard/ai-configuration/components/TestPrompt.tsx, seen in P5.
export function TestPrompt({ fullPrompt, model }: any) {
  const run = () =>
    fetch("/api/prompts/test", { method: "POST", body: JSON.stringify({ fullPrompt, model }) });
  return <button onClick={run}>Test</button>;
}
