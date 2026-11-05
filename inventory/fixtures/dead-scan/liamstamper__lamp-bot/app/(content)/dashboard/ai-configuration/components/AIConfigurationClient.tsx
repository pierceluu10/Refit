// Excerpt of liamstamper/lamp-bot, app/(content)/dashboard/ai-configuration/components/AIConfigurationClient.tsx, seen in P5.
"use client";
import { TestPrompt } from "./TestPrompt";

function mapPromptConfig(dbConfig: any) {
  return {
    id: dbConfig.id,
    model: dbConfig.model || "gpt-4o",
  };
}

export function AIConfigurationClient({ dbConfig, prompt }: any) {
  const activeConfig = dbConfig && mapPromptConfig(dbConfig);
  const handleAIGenerate = async () => {
    const response = await fetch("/api/prompts/testPrompt", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
      }),
    });
    return response.json();
  };
  return (
    <div onClick={handleAIGenerate}>
      {activeConfig && (
        <TestPrompt
          fullPrompt={prompt}
          model={activeConfig?.model || "llama-3.3-70b-versatile"}
        />
      )}
    </div>
  );
}
