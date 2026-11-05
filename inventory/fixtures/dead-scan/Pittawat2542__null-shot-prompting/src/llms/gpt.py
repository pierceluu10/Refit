# Excerpt of Pittawat2542/null-shot-prompting, src/llms/gpt.py, seen in P5.
import openai

from src.config import GPT_THREE_POINT_FIVE_TURBO_MODEL, GPT_FOUR_TURBO_MODEL


class GPT:
    def inference(self, prompt: str, model_name=""):
        model = ""
        match model_name:
            case "gpt-3.5-turbo":
                model = GPT_THREE_POINT_FIVE_TURBO_MODEL
            case "gpt-4-turbo":
                model = GPT_FOUR_TURBO_MODEL
            case _:
                raise NotImplementedError(f"Model {model_name} not implemented")
        return openai.Client().chat.completions.create(model=model, messages=[])
