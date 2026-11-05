// Excerpt of atrueempire/yk, config/provider/azure.ts, seen in P5. Its import is commented out.
import { Model } from '@/types/model';

export type AzureOpenAIModelId =
    | 'gpt-4'
    | 'gpt-4-0613';

export const model: Model[] = [
    {
        id: 'gpt-4',
        name: 'GPT-4',
        maxInputTokens: null,
        maxOutputTokens: 4096,
        maxTokens: 200000,
        price: 18.0,
    },
    {
        id: 'claude-2.0',
        name: 'A record nothing offers',
        maxOutputTokens: 4096,
    },
];
