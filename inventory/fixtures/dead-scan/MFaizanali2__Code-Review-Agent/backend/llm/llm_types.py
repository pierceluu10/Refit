# Excerpt of MFaizanali2/Code-Review-Agent at 32fd5bb17d89, backend/llm/llm_types.py.
PROVIDER_CONFIGS = {
    Provider.GEMINI: {
        "default_model": "gemini-2.0-flash",
        "package": "google-generativeai",
        "base_url": None,
    },
    Provider.OPENAI: {
        "default_model": "gpt-4o-mini",
        "package": "openai",
        "base_url": "https://api.openai.com/v1",
    },
    Provider.GROQ: {
        "default_model": "llama-3.3-70b-versatile",
        "package": "openai",
        "base_url": "https://api.groq.com/openai/v1",
    },
    Provider.ANTHROPIC: {
        "default_model": "claude-sonnet-4-20250514",
        "package": "anthropic",
        "base_url": "https://api.anthropic.com/v1",
    },
    Provider.OPENROUTER: {
        "default_model": "openai/gpt-4o-mini",
        "package": "openai",
        "base_url": "https://openrouter.ai/api/v1",
    },
}
