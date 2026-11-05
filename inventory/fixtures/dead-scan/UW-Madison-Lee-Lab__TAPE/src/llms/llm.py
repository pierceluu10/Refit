# Excerpt of UW-Madison-Lee-Lab/TAPE, src/llms/llm.py, seen in P5. Nothing imports src/llms from outside.
from llms.openai_utils import chat_completion_request


class ChatBase:
    def _supports_sampling_params(self) -> bool:
        name = self.model
        return not ("gpt-5" in name or any(x in name for x in ("o1", "o3", "o4")))

    def chat(self, messages):
        return chat_completion_request(messages, model=self.model)
