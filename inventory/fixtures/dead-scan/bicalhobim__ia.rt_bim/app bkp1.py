# Excerpt of bicalhobim/ia.rt_bim, app bkp1.py, seen in P5.
from flask import Flask, request
from openai import OpenAI
cliente = OpenAI()
app = Flask(__name__)


def bot(prompt, thread, assistente):
    cliente.beta.threads.messages.create(thread_id=thread.id, role="user", content=prompt)
    run = cliente.beta.threads.runs.create(thread_id=thread.id, assistant_id=assistente)
    return run


if __name__ == "__main__":
    app.run()
