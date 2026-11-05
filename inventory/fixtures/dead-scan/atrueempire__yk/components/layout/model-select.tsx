// Excerpt of atrueempire/yk, components/layout/model-select.tsx, seen in P5.
// import { model as AzureOpenAIModel } from '@/config/provider/azure';
import { model as AnthropicModel } from '@/config/provider/anthropic';
import { model as FireworksModel } from '@/config/provider/fireworks';
import { model as MistralModel } from '@/config/provider/mistral';
import { model as OpenAIModel } from '@/config/provider/openai';
import { model as PerplexityModel } from '@/config/provider/perplexity';

export const ModelSelect = ({ onPick }) => (
    <DropdownMenu>
        <DropdownMenuItem onClick={() => onPick()} />
        {/* <ModelSelector models={AzureOpenAIModel} /> */}
        <ModelSelector models={AnthropicModel} />
        <ModelSelector models={FireworksModel} />
        <ModelSelector models={MistralModel} />
        <ModelSelector models={OpenAIModel} />
        <ModelSelector models={PerplexityModel} />
    </DropdownMenu>
);
