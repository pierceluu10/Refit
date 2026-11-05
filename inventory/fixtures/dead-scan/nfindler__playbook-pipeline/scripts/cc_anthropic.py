# Excerpt of nfindler/playbook-pipeline, scripts/cc_anthropic.py, seen in P5.
import subprocess


def _model_alias(model):
    return "opus" if "opus" in model else "sonnet"


class Anthropic:
    def create(self, model, messages):
        return subprocess.run(["claude", "-p", "--model", _model_alias(model)])
