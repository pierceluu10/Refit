# Excerpt of lissettecarlr/chat-openai-streamlit, src/pages/chat.py, seen in P5.
from openai import OpenAI
import tiktoken


def num_tokens_from_messages(messages, model="gpt-3.5-turbo-0613"):
    encoding = tiktoken.encoding_for_model(model)
    if model == "unknown":
        raise NotImplementedError(
            f"""model {model} not supported. Please add it to the num_tokens_from_messages function."""
        )
    return sum(len(encoding.encode(one["content"])) for one in messages)


def main(chat_messages, model_name):
    client = OpenAI()
    num_tokens = num_tokens_from_messages(chat_messages, model=model_name)
    return client.chat.completions.create(model=model_name, messages=chat_messages), num_tokens


main([], "gpt-5")
