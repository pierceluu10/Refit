// Excerpt of benlamiro/ShipGenAI at 10037d3d3fcf, portrait_avatar/ai-character-studio/src/lib/registry.js, seen in P5.
  "ai-chat": {
    id: "ai-chat",
    name: "AI Companion Chatbot",
    description: "Create customized companion personalities or expert support bots. Fits standard chat timelines and floating console boxes.",
    component: ChatTemplate,
    modelEndpoint: "chat/completions",
    defaultConfig: {
      systemPrompt: "You are an empathetic, highly knowledgeable assistant. Respond details in clear concise markdown format.",
      model: "gpt-4o",
    },
    configFields: [
      { name: "systemPrompt", label: "Bot Personality Instructions", type: "textarea", placeholder: "e.g., You are a futuristic guide who speaks with mechanical metaphors..." },
      { name: "model", label: "LLM Model", type: "select", options: ["gpt-4o", "claude-3-5-sonnet", "gemini-1.5-pro"] }
    ]
  },
