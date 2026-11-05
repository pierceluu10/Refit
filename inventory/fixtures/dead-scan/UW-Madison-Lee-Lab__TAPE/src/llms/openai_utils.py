# Excerpt of UW-Madison-Lee-Lab/TAPE, src/llms/openai_utils.py, seen in P5.
from openai import OpenAI

client = OpenAI()


def chat_completion_request(messages, model: str = "gpt-3.5-turbo-0613", **kwargs):
    return client.chat.completions.create(model=model, messages=messages, **kwargs)


if __name__ == "__main__":
    message = chat_completion_request([], model="gpt-4-turbo-preview", max_tokens=100)
    print(message)
    import pdb

    pdb.set_trace()
