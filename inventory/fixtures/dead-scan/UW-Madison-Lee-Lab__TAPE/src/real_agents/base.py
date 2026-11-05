# Excerpt of UW-Madison-Lee-Lab/TAPE, src/real_agents/base.py, seen in P5.
from utils.llm import ChatBase, client


def make(model):
    return ChatBase(model), client
