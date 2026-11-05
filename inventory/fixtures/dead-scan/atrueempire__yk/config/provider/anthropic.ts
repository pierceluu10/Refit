// Excerpt of atrueempire/yk, config/provider/anthropic.ts, seen in P5.
import { Model } from '@/types/model';

export type AnthropicModelId = 'claude-3-sonnet-20240229' | 'claude-2.1';

export const model: Model[] = [
    {
        id: 'claude-3-sonnet-20240229',
        name: 'Claude 3 Sonnet',
        maxInputTokens: null,
        maxOutputTokens: 4096,
        maxTokens: 200000,
        price: 18.0,
        vision: true,
    },
    {
        id: 'claude-2.1',
        name: 'Claude 2.1',
        maxInputTokens: null,
        maxOutputTokens: 4096,
        maxTokens: 200000,
        price: 18.0,
        vision: false,
    },
];
