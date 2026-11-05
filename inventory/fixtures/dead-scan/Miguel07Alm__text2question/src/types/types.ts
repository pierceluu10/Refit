// Excerpt of Miguel07Alm/text2question at ce789503da89, src/types/types.ts, seen in P5.
export type Model = "deepseek-chat" | "gpt-4o-mini" | "gemini-2.0-flash";

export const ModelToLanguageModel: Record<Model, LanguageModelV1> = {
    "deepseek-chat": deepseek("deepseek-chat"),
    "gpt-4o-mini": openai("gpt-4o-mini"),
    "gemini-2.0-flash": google("gemini-2.0-flash"),
}
