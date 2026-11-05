// Excerpt of rainmana/cursorify at 464d61f74e76, src/providers/anthropic-provider.ts, seen in P5.
export class AnthropicProvider extends BaseLLMProvider {
  readonly name = 'anthropic';
  readonly displayName = 'Anthropic Claude';
  readonly requiresApiKey = true;
  readonly defaultModel = 'claude-3-5-sonnet-20241022';
  /**
   * Get available Anthropic models
   */
  getAvailableModels(): string[] {
    return [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307'
    ];
  }
