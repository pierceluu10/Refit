# Excerpt of adri14gl/Chatbot-multiproveedor-con-fallback-y-streaming, providers/anthropic_provider.py, seen in P5.
import anthropic


class AnthropicProvider:
    def __init__(self, api_key: str = "", model: str = "claude-3-7-sonnet-latest"):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    def send(self, text):
        return self.client.messages.create(model=self.model, max_tokens=100, messages=[{"role": "user", "content": text}])
