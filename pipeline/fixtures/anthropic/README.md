# Anthropic retrieval fixture

This fixture gives the doc-grounded patch eval one Anthropic case. The before contract includes `Message.max_tokens`. The after contract removes it. That removal is synthetic and is not a claim about Anthropic's live API.

The adapter maps `messages.create` to `Message`. The repository reads `message.max_tokens` from that call. Retrieval is expected to surface the pinned Messages passage for `max_tokens`.
