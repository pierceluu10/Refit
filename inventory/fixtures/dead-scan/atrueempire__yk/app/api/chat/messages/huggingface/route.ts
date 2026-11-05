// Excerpt of atrueempire/yk, app/api/chat/messages/huggingface/route.ts, seen in P5.
import { HfInference } from '@huggingface/inference';

export async function POST(req) {
    const { messages, config } = await req.json();
    const huggingface = new HfInference(process.env.HUGGINGFACE_API_KEY ?? '');

    const response = huggingface.textGenerationStream({
        model: config.model.model_id,
        inputs: messages,
    });
    return response;
}
