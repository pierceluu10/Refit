# Excerpt of Pittawat2542/null-shot-prompting, src/models/types.py, seen in P5.
from enum import Enum


class LLMs(Enum):
    gpt_three_point_five_turbo = "gpt-3.5-turbo"
    gpt_four_turbo = "gpt-4-turbo"
    claude_2_1 = "claude-2.1"
