# Excerpt of MFaizanali2/Code-Review-Agent at 32fd5bb17d89, backend/llm/llm_client.py.
PRICES = {
    "gemini-2.0-flash": {"input": 0.0001, "output": 0.0004},
    "llama-3.3-70b-versatile": {"input": 0.00059, "output": 0.00079},
    "claude-sonnet-4-20250514": {"input": 0.003, "output": 0.015},
}


class LLMClient:
    def __post_init__(self):
        if self.model == "gemini-2.0-flash" or not self.model or self.model == "unknown":
            self.model = cfg.get("default_model", self.model)

    async def list_models(self):
        if self.provider == Provider.GEMINI.value:
            return ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"]
        elif self.provider == Provider.ANTHROPIC.value:
            return ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-3-5-20241022"]
        return []

    async def _call_anthropic(self, messages):
        kwargs = {
            "temperature": self.config.temperature,
        }
        return await self._client.messages.create(model=self.model, temperature=self.config.temperature)


def create_gemini_client(api_key: str, model: str = "gemini-2.0-flash") -> LLMClient:
    return LLMClient(api_key, model)


def create_groq_client(api_key: str, model: str = "llama-3.3-70b-versatile") -> LLMClient:
    return LLMClient(api_key, model)


def create_anthropic_client(api_key: str, model: str = "claude-sonnet-4-20250514") -> LLMClient:
    return LLMClient(api_key, model)
