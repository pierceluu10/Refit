---
provider: openai
kind: rest-to-graphql
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/reference/overview
---

Rarely applies: the OpenAI API is REST (plus SSE streaming, WebSocket and WebRTC for realtime) and has no GraphQL surface ([API overview](https://developers.openai.com/api/reference/overview)). For the closest real migration, a change of API surface (Chat Completions or Assistants to Responses), see the endpoint-removed playbook.
