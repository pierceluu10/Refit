export type LifecycleMarker = {
  dependency: string;
  kind: string;
  target: string;
  changeId: string;
};

const MARKER_FIELDS = ['dependency', 'kind', 'target', 'changeId'] as const;
const MARKER_PATTERN = /<!-- refit:lifecycle (.*?) -->/gs;

// JSON strings can carry these as \u escapes, so a watcher-supplied name can't end the comment.
const escapeForComment = (json: string) =>
  json.replaceAll('>', '\\u003e').replaceAll('--', '\\u002d\\u002d');

export const formatMarker = (marker: LifecycleMarker) => {
  const { dependency, kind, target, changeId } = marker;
  const json = JSON.stringify({ dependency, kind, target, changeId });
  return `<!-- refit:lifecycle ${escapeForComment(json)} -->`;
};

export const withMarker = (body: string, marker: LifecycleMarker) =>
  `${body}\n\n${formatMarker(marker)}`;

function decode(json: string): LifecycleMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const fields = parsed as Record<string, unknown>;
  return MARKER_FIELDS.every((field) => typeof fields[field] === 'string')
    ? (parsed as LifecycleMarker)
    : undefined;
}

// The last marker wins: Refit appends its own, and a body may quote text that looks like one.
export function parseMarker(body: string | null): LifecycleMarker | undefined {
  const last = [...(body ?? '').matchAll(MARKER_PATTERN)].at(-1);
  return last ? decode(last[1]) : undefined;
}
