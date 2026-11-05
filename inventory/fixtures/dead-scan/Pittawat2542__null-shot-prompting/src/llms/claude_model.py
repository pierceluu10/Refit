# Excerpt of Pittawat2542/null-shot-prompting, src/llms/claude_model.py, seen in P5.
import anthropic

from src.config import CLAUDE_2_1_MODEL


class Claude:
    def inference(self, prompt: str, model_name=""):
        match model_name:
            case "claude-2.1":
                model = CLAUDE_2_1_MODEL
        return anthropic.Anthropic().messages.create(model=model, messages=[], max_tokens=10)
