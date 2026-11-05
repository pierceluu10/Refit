# Excerpt of adri14gl/Chatbot-multiproveedor-con-fallback-y-streaming, main.py, seen in P5.
import os
from providers import AnthropicProvider


def main():
    provider = AnthropicProvider(api_key=os.getenv("ANTHROPIC_API_KEY", ""), model=os.getenv("ANTHROPIC_MODEL", "claude-3-7-sonnet-latest"))
    print(provider.send("hola"))


if __name__ == "__main__":
    main()
