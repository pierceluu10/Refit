# Excerpt of UW-Madison-Lee-Lab/TAPE, src/llms/gemini_utils.py, seen in P5. Nothing imports this one.
from openai import OpenAI

client = OpenAI()

if __name__ == "__main__":
    print(client.chat.completions.create(model="gpt-4-turbo-preview", messages=[]))
