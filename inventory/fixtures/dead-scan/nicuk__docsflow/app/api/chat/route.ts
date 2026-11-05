// Excerpt of nicuk/docsflow, app/api/chat/route.ts, seen in P5.
import { OpenRouterClient, MODEL_CONFIGS } from '@/lib/openrouter-client';
import { queryClassifier } from '@/lib/query-complexity-classifier';

export async function POST(request: Request) {
  const { message } = await request.json();
  const complexityAnalysis = queryClassifier.classify(message);
  let selectedModels: string[];
  const hasPremiumAI = false;

  switch (complexityAnalysis.complexity) {
    case 'simple':
      selectedModels = MODEL_CONFIGS.SIMPLE;
      break;
    case 'complex':
      if (hasPremiumAI) {
        selectedModels = MODEL_CONFIGS.PREMIUM;
      } else {
        selectedModels = MODEL_CONFIGS.COMPLEX;
      }
      break;
    default:
      selectedModels = MODEL_CONFIGS.MEDIUM;
  }
  return new OpenRouterClient().generateWithFallback(selectedModels, message);
}
