# Phase 1: Live exposure and tracing - Pattern Map

**Mapped:** 2026-10-21
**Files analyzed:** 8 (all modifications; no new source files)
**Analogs found:** 8 / 8 (the analog is the file itself or its test sibling)

Line numbers are from the tree at commit b44b124. All paths are git-tracked. Re-check lines before editing (the two source files change often).

## File Classification

| Modified file | Role | Data Flow | Closest analog (in-file pattern to copy) | Match |
|---------------|------|-----------|------------------------------------------|-------|
| `pipeline/deadline-exposure.ts` | utility (syntax classifier) | transform | `literalUse()` lines 178-218, `tokenUses()` 233-264 | exact |
| `pipeline/model-retirements.ts` | service (symbol tracer) | transform | `modelSites()` 455-536, `requestObject()` 424-449, `usesOf` 239-267, decision loop 655-693 | exact |
| `pipeline/deadlines.test.ts` | test | request-response | `uses(files)` helper 249-256, `classifying` 241-247, test at 258+ | exact |
| `pipeline/model-retirements.test.ts` | test | request-response | `repository()` 20-35, `registry` 52-88, test at ~100-215 | exact |
| `scripts/ai-model-benchmark.mjs` | utility (script) | batch | `summary` block lines 119-131 | exact |
| `pipeline/deadlines-cli.ts` (optional) | utility (CLI output) | transform | `printNonLive()` 287-302 | exact |
| `docs/DEADLINES.md` | docs | n/a | table rows `catalog` (~77), `comment` (~81), eligibility (~188-196), stops (~202-206), limits (~250) | exact |
| `AGENTS.md`, `.planning/PROJECT.md` | docs | n/a | `#120` model-fixes bullet at end of AGENTS.md (dated owner-decision bullet) | exact |

## Pattern Assignments

### `pipeline/deadline-exposure.ts` (D-01, D-02, D-03, per-use counts)

**Analog:** itself. Add rules inside `literalUse()`; keep the guard order.

**Guard order to preserve** (lines 190-199): `if (!model) return 'live'` runs before every new rule, which keeps Meta/Shopify unchanged.
```ts
if (!model) return 'live';
...
if (propertyKey(node)) return 'catalog';
if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return 'catalog';
```

**D-02 insertion point:** right after line 199 (`return 'catalog'` for element access), before the `for` climb. Build `unwrapUp` like the existing wrapper set in `isLiteralStructure` (144-156: As, Satisfies, Parenthesized, TypeAssertion; add NonNull). Descriptor keys `id,name,displayName,label,title,slug`; `versions: [...]` array element. `value`, `model*`, `version`, `default` stay live (D-15).

**D-01 bug (line 205-212):** `current` is the `SatisfiesExpression`/`AsExpression`, so `ts.isObjectLiteralExpression(current)` is false. Fix by testing the unwrapped-down node:
```ts
    if (
      ts.isPropertyAssignment(up) &&
      up.initializer === current &&
      ts.isObjectLiteralExpression(current) &&   // -> unwrapDown(current)
      ts.isStringLiteralLike(up.name) &&
      isModel(up.name.text)
    )
      return 'catalog';
```

**D-03 prose rule:** in `tokenUses` return callback (lines 247-263). Signature gains `version`. Current tail to extend:
```ts
const model = MODEL_PROVIDERS.has(provider);
const use = ts.isStringLiteralLike(node) ? literalUse(node, path, model, isModel) : 'live';
// An HTML or JSX `<option>` is one choice in a picker.
return use === 'live' && model && OPTION_ELEMENT.test(line) ? 'catalog' : use;
```
Apply prose LAST and only when result is `live` (after the `<option>` rule), or the existing `<option>`-in-template fixture regresses. Cover template pieces and JsxText too (today they skip `literalUse`, line 257). Prose = `node.text !== version`. Guard (D-18): keep `live` when a `"model":` key precedes the match. Call site at line ~335 passes `match.version`.

**Per-use counts (D-05):** compute in the final loop (lines 365-376) before `slice`:
```ts
const rest = exposure.nonLive.filter((item) => !live.has(`${item.file}:${item.line}:${item.version}`));
exposure.nonLive = rest.slice(0, MAX_EVIDENCE);
exposure.nonLiveMore = rest.length - exposure.nonLive.length;
// add: exposure.nonLiveCounts = count of rest by item.use (optional field on DeadlineExposure)
```
Make the new field optional so the hand-built `DeadlineExposure` in `deadlines.test.ts` (~859-882) still typechecks. Do not touch `CATALOG_SIZE` (line 131, D-04).

---

### `pipeline/model-retirements.ts` (D-06..D-11, D-16, D-17)

**Analog:** itself. Output shapes `ModelReplacement`/`ModelReplacementStop` (lines 106-142) must not change.

**Non-text calls (D-11, D-16):** extend beside `MODEL_CALLS` (17-36) and `TRACERS` (51-72). Keep the "why" comment style with provider source and date.
```ts
const MODEL_CALLS: Record<string, Set<string>> = { openai: new Set([...]), anthropic: new Set([...]) };
// TRACERS entries: { provider, adapter, resourceCalls: MODEL_CALLS.openai }
```
Add `NON_TEXT_CALLS` (or catch-all per D-16: traced call outside `MODEL_CALLS` with a `model` property) and give each request `text: boolean`. At filter (lines 607-614) accept `resourceCalls.has(call) || nonText`. Reason inserted right after the `!resolved.to` check in the chain at 672-682:
```ts
const reason = !resolved.to
  ? 'The registry names no concrete replacement model ID.'
  : /* NEW non-text: `\`${request.call}\` is not a text-generation call; ${resolved.to} may change formats or parameters; change it by hand.` */
  : site.stop ? `${site.stop} ${resolved.to}.` : found.shared ? ... 
```
Raw endpoints: copy the `RAW_ENDPOINTS` shape (186-192), add `text: boolean` and non-text patterns (`/v1/images/generations`, `/audio/speech`, `/embeddings`, `/moderations`, `/completions`; Anthropic `api\.anthropic\.com\/v1\/complete(?![\w/-])`). Use the same negative lookahead `(?![\w/-])`. Call label comes from `/\/v1\/[\w/]+/` at line 412.

**Resolver (D-06..D-08):** replace `modelSites()` internals with a memoized `valuesOf` returning literals plus "passes" (see RESEARCH.md Pattern 1). Existing structure to extend, keeping the same `unwrap` + `program.symbolOf` + `valueDeclaration` shape:
```ts
const reference = ts.isPropertyAccessExpression(value) ? value.name : value;
if (!ts.isIdentifier(reference)) return [];
const symbol = program.symbolOf(reference);
const declaration = symbol?.valueDeclaration;
```
Existing `??`/`||` handling (458-466) only follows the right side when non-literal; extend to both sides and conditionals. Parameter branch (494-534) is the template for constructor callers (`new Class(...)`) and method callers; its `callable` name logic is at 500-510.

**Order-dependent stop bug (D-17, lines 517-528):** `sites.forEach(site => site.stop ??= ...)` runs only on sites collected so far. Apply the stop to every terminal after the loop.

**Shared-use gate (D-09):** today at lines 480-490:
```ts
const uses = program.usesOf(symbol).length;
...(uses !== 1 ? { stop: `The model comes from the ${kind} ${reference.text} (${at}), which is used ${uses} times; change it by hand to` } : {})
```
Keep the sentence byte-identical (tests assert "constant MODEL ... used 2 times"). Move the check to decision time: first pass collects `reached` pass nodes from all non-test requests; second pass, at the position of `site.stop` in the reason chain (line 674), stops when any non-type use is not in `reached`. `requestObject` "used N times" (442-448) stays unchanged.

**Assignments index (D-06):** `usesOf` (239-267) skips `x.name = v` via `declarationName` (295-299). Add a `writes` map in the same lazy per-name builder; accept `ts.PrivateIdentifier`.

**Default exports (D-17):** `usesOf` keys by `symbol.name`, which is `'default'` for default exports, so callers are missed. Fix near lines 243-247 (also scan import bindings aliasing the default export).

**Decision loop to reuse** (655-693) and edit emission (719-735): untouched except the added reason branch and the reached-set check. Test-path skip stays: `if (TEST_PATH.test(file)) continue;` (658).

---

### `pipeline/model-retirements.test.ts` (TRAC-01..07)

**Analog:** the existing tests in the same file.

**Fixture helper** (lines 20-35): `repository({ 'src/x.ts': [...].join('\n') })` writes `package.json` with `openai` and `@anthropic-ai/sdk`. Then:
```ts
const proposal = await proposeModelReplacements(root, registry, NOW);
expect(proposal.stops.map((item) => [item.line, item.model, item.reason])).toEqual([...]);
```
Registry has `gpt-4`->`gpt-5.6-sol`, `o1-mini`->`o4-mini`->`gpt-5.6-terra`, `claude-3-opus-20240229`->`claude-opus-4-8`. Add `dall-e-3`, `whisper-1`, `tts-1`, `gpt-image-2` style entries via a local registry for non-text tests.

Source lines are written as string arrays: `"import OpenAI from 'openai';", 'const openai = new OpenAI();', "await openai.chat.completions.create({ model: 'gpt-4', messages });"`.

Must update two existing expectations that D-11 changes: embeddings at ~line 182 (`openai.embeddings.create({ model: 'gpt-4', input: 'x' })`, now a stop) and the raw `/v1/embeddings` fetch at ~line 371 (now a `fetch /v1/embeddings` stop). Keep "constant MODEL", "LABEL_MODEL", "request", "ask" messages byte-identical. Sort mapped arrays (output order follows discovery order). Apply patches via `git init` + `git apply` as the existing patch tests do.

New fixtures to add (RESEARCH.md table "Test shapes"): class field, `this.x =`, constructor parameter property + `new C(...)`, `MODELS.GPT4 as const`, env fallback, ternary, `getModel()`, destructuring default, options-object param, D-09 positive and negative, `pick('gpt-4')` call context, default-exported function with callers, by-value helper declared in file order a/b/c.

---

### `pipeline/deadlines.test.ts` (EXPO-01..03)

**Analog:** `uses()` helper and the first test (lines 241-275).
```ts
const classifying: DeadlineRegistry = { formatVersion: 1, deadlines: [...registry.deadlines, entry({ id: 'openai-o1', ... })] };
async function uses(files: Record<string, string>) {
  const scan = await scanDeadlines(await repository(files), classifying, NOW);
  const result: Record<string, string> = {};
  for (const exposure of [...scan.exposures, ...scan.mentions])
    for (const item of [...exposure.evidence, ...exposure.nonLive])
      result[`${item.file}:${item.line} ${item.version}`] = item.use;
  return { scan, result };
}
```
Assert `result['src/x.ts:1 gpt-4']` equals `'catalog'`/`'comment'`/`'live'`. Keep the "Two models are not yet a list" live fixture (D-04). Use a non-descriptor inner key (`model:`) in the D-01 test so it does not pass via D-02. Add a Meta/Shopify unchanged fixture for D-03. If new model IDs are needed (`dall-e-3`, Claude IDs), add them to `classifying`.

---

### `scripts/ai-model-benchmark.mjs` (D-05)

**Analog:** lines 119-131.
```js
const exposed = results.filter((item) => item.exposures?.length);
const summary = {
  repositories: results.length,
  ...
  exposedSilent: exposed.filter((item) => !item.replacements.length && !item.stops.length).length,
```
Keep every existing key. Add per-repository `nonLive` (sum `group.nonLiveCounts` over `exposures` and `mentions` for `frozen.provider`) and summary `mentionedOnly`. Top-level script with no test harness; validate with a network-free run on a prepared checkout directory.

---

### `pipeline/deadlines-cli.ts` (optional)

**Analog:** `printNonLive()` (lines 287-302) collapses non-live evidence per use, with `…and N more`. Print the exact per-use counts from `nonLiveCounts` next to it. Wrap output in `terminalText()` as the existing line does.

---

### Docs and decision records

- `docs/DEADLINES.md`: update the rows listed in RESEARCH.md "Docs to update" (catalog, comment, propose eligibility, stop list, non-text sentence at ~206, limits ~250). Do not touch `docs/READINESS.md` or `docs/PROVIDER-GOALS.md` (Phase 4).
- `AGENTS.md`: add a dated bullet (2026-10-21, by Otabek Alimov, pending the repository owner's review on the phase PR) beside the "Retiring AI models (owner decision, 2026-10-20, #120)" bullet. Match its voice: decision, scope, "Do not widen ... without a new decision."
- `.planning/PROJECT.md`: update the Key Decisions row for D-09.

## Shared Patterns

### Tests build throwaway repos with `mkdtemp`
**Source:** `pipeline/model-retirements.test.ts:15-35`, `pipeline/deadlines.test.ts:75-91`
**Apply to:** every new test. `afterEach` removes `roots`. Test files must sit directly in `pipeline/` (vitest includes `pipeline/*.test.ts` only).

### Stop reason sentences
**Source:** `pipeline/model-retirements.ts:488,519,526,447`
**Apply to:** all new stops. Human sentence naming kind, name, `file:line`, ending with "change it by hand to" + replacement + ".". Nouns: constant, enum member, field, function/helper, class.

### Tracked-comment style
Comments explain why and cite provider pages with dates (global rule: hardcoded data carries source and date). Apply to `NON_TEXT_CALLS`, raw endpoint patterns and the Anthropic `/v1/complete` note (source: platform.claude.com completions page, checked 2026-10-21).

### Independence of scan and tracer
The scan marks `{ id: 'gpt-4' }` catalog, the tracer still replaces `model: MODEL.id`. Add a test; never filter tracer sites by scan class.

### Safety limits
Per-request memoization, work budget (~2,000) and depth (~10) for the new resolver; parse only, never execute repository code.

### Verification commands
`npm test`, `npm run typecheck`, `npm run format:check` (prettier: single quotes, width 100, trailing commas). Gated: `REFIT_DOCKER_IMAGE=node:22-alpine npx vitest run pipeline/model-fixes-docker.test.ts`; report separately.

## No Analog Found

None for files. Sub-features with no in-repo precedent (use RESEARCH.md Pattern 1 and the prototype described there):

| Feature | Role | Data Flow | Reason |
|---------|------|-----------|--------|
| `valuesOf` memoized resolver with passes | service | transform | `modelSites` is non-memoized and has no pass tracking |
| `assignmentsOf` writes index | utility | transform | `usesOf` excludes assignments by design |
| Constructor/`new` caller following | service | transform | Only function-declaration/arrow helpers are followed today |

## Metadata

**Analog search scope:** `pipeline/`, `scripts/`, `docs/`, `AGENTS.md`
**Files scanned:** 7 source/test/script files plus CONTEXT.md and RESEARCH.md
**Pattern extraction date:** 2026-10-21
