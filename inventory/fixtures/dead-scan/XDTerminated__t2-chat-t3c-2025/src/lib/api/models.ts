// Excerpt of XDTerminated/t2-chat-t3c-2025, src/lib/api/models.ts, seen in P5.
export const GEMINI_MODELS = [
  { id: "gemini-2.0-flash-exp", name: "Gemini 2.0 Flash", contextLength: 1048576, provider: "Google" },
];
export const GROQ_MODELS = [
  { id: "deepseek-r1-distill-llama-70b", name: "DeepSeek R1", contextLength: 128000, provider: "Groq" },
  { id: "qwen/qwen3-32b", name: "Qwen 3", contextLength: 128000, provider: "Groq" },
];
export const OPENROUTER_MODELS = [
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5", contextLength: 200000, provider: "Anthropic" },
  { id: "anthropic/claude-4-sonnet", name: "Claude 4", contextLength: 200000, provider: "Anthropic" },
  { id: "deepseek/deepseek-r1-qwen3-8b", name: "R1 Qwen", contextLength: 64000, provider: "DeepSeek" },
];
export const FREE_MODELS = [
  { id: "qwen/qwq-32b:free", name: "Qwen 32B Free", contextLength: 40000, provider: "Qwen" },
];
export const MODEL_GROUPS = {
  gemini: GEMINI_MODELS,
  groq: GROQ_MODELS,
  openrouter: OPENROUTER_MODELS,
  free: FREE_MODELS,
};
