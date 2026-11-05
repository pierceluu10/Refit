// Excerpt of XDTerminated/t2-chat-t3c-2025, src/components/model-selector.tsx, seen in P5.
import { MODEL_GROUPS } from "~/lib/openrouter";

export function ModelSelector({ onSelect }) {
  return Object.entries(MODEL_GROUPS).map(([provider, models]) => (
    <div key={provider}>
      {models.map((model) => (
        <button key={model.id} onClick={() => onSelect(model)}>{model.name}</button>
      ))}
    </div>
  ));
}
