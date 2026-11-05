// Excerpt of Small-Web-Co/tinypivot at 69caa7e03901, api/ai-proxy.ts.
function getDefaultModel(provider: AIProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-3-haiku-20240307';
    case 'openrouter':
      return 'anthropic/claude-3-haiku';
    case 'openai':
      return 'gpt-4o-mini';
  }
}

export const callAnthropic = (body: string) =>
  fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });
