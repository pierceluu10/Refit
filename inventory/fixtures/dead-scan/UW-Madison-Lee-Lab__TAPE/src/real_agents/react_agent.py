# Excerpt of UW-Madison-Lee-Lab/TAPE, src/real_agents/react_agent.py, seen in P5.
from real_agents.base import make
from utils.llm import client


def run(model):
    return make(model), client
