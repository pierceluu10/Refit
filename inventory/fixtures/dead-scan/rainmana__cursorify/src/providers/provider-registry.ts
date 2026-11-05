// Excerpt of rainmana/cursorify at 464d61f74e76, src/providers/provider-registry.ts, seen in P5.
import pc from 'picocolors';
import { LLMProvider, ProviderType, ProviderRegistry, LLMProviderConfig } from '../types/llm-provider.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { LocalProvider } from './local-provider.js';

  /**
   * Get provider information for display
   */
  getProviderInfo(): Array<{
    name: string;
    displayName: string;
    requiresApiKey: boolean;
    defaultModel: string;
    availableModels: string[];
  }> {
    return this.listProviders().map(provider => ({
      name: provider.name,
      displayName: provider.displayName,
      requiresApiKey: provider.requiresApiKey,
      defaultModel: provider.defaultModel,
      availableModels: provider.getAvailableModels()
    }));
  }
