// Excerpt of nicuk/docsflow, app/api/tenant/regenerate-persona/route.ts, seen in P5.
import { aiProvider } from '@/lib/ai/providers';
import { createSupabaseClient } from '@/lib-frontend/supabase';

export async function POST(request: Request) {
  createSupabaseClient();
  return aiProvider.generatePersona(await request.text());
}
