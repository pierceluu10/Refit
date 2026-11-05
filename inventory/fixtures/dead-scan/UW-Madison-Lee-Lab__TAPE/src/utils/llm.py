# Excerpt of UW-Madison-Lee-Lab/TAPE, src/utils/llm.py, seen in P5. This one is the module that runs.
from openai import OpenAI

client = OpenAI()


class MoneyManager:
    def __init__(self, model: str = "gpt-3.5-turbo-0613"):
        self.model = model


def chat_completion_request(
    messages,
    functions=None,
    model: str = "gpt-3.5-turbo-0613",
    **kwargs,
):
    return client.chat.completions.create(model=model, messages=messages, **kwargs)


def completion_request(prompt, model: str = "gpt-3.5-turbo-0613", **kwargs):
    return client.completions.create(model=model, prompt=prompt, **kwargs)


class ChatBase:
    def __init__(self, model):
        self.model = model
        self.money: MoneyManager | None = MoneyManager(model=model)

    def _supports_sampling_params(self) -> bool:
        name = self.model
        return not ("gpt-5" in name or any(x in name for x in ("o1", "o3", "o4")))

    def chat(self, messages, tool=None, **req_kwargs):
        if tool:
            return chat_completion_request(messages, tool, model=self.model, **req_kwargs)
        return chat_completion_request(messages, model=self.model, **req_kwargs)

    def complete(self, prompt):
        return completion_request(prompt, model=self.model)
