# Playbook: AI transparency (EU AI Act Article 50)

Guidance for a smart engineer, not rules. Refit doesn't give legal advice.

## What the rule's text points to

The AI Act's Article 50 applies from 2 August 2026:

- 50(1): people interacting directly with an AI system are told so, unless it's obvious.
- 50(2): synthetic audio, image, video or text output is marked in a machine-readable way and detectable as artificially generated.
- Other duties (emotion recognition, deep fakes, high-risk systems) need a person's reading of the use case.

## Where it shows up in code

- Chat widgets and assistants that answer users with model output and present as a person or with no label.
- Generated images, audio or text that users download or publish with no metadata or marker.
- Automated emails or support replies written by a model.

## What to change

- Add a clear, persistent disclosure at the start of an AI conversation ("You're chatting with an AI assistant") and on AI-written messages.
- Add machine-readable marks where the output format supports them (for example C2PA or IPTC metadata on images, a field in API responses), and say which formats aren't covered.

## What to check

- A test or snapshot showing the disclosure renders on the chat surface.
- The marker is present on generated files the code produces.

## What a person must confirm

- Whether the business is a provider or a deployer of the system, and which duties fall on each.
- Whether any use case is high-risk under the Act; that is far beyond a disclosure label.
- The disclosure wording.

## Pitfalls

- A disclosure only in the terms of service, not where the interaction happens.
- Markers stripped by image processing later in the pipeline.
