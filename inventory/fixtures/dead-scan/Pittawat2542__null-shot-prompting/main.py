# Excerpt of Pittawat2542/null-shot-prompting, main.py, seen in P5.
from src.models.types import LLMs
from src.llms.gpt import GPT
from src.llms.claude_model import Claude


def run(model: LLMs, prompt: str):
    if model is LLMs.claude_2_1:
        return Claude().inference(prompt, model_name=model.value)
    return GPT().inference(prompt, model_name=model.value)


run(LLMs.gpt_four_turbo, "hello")
