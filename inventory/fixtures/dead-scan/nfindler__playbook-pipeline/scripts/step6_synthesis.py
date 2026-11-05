# Excerpt of nfindler/playbook-pipeline, scripts/step6_synthesis.py, seen in P5.
import json
import cc_anthropic as anthropic  # the $0 transport

OPUS_MODEL = "claude-opus-4-20250514"

client = anthropic.Anthropic()
response = client.messages.create(model=OPUS_MODEL, max_tokens=8000, messages=[])
print(json.dumps(response))
