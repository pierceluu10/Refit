# Python model tracer

Refit reads Python code for the models it sends to OpenAI, Anthropic and Gemini, and reports each retiring model against `data/deadlines.json`. It is detection and reporting only: Python is never edited (decision 3 in [Architecture](ARCHITECTURE.md#other-languages-decisions-2026-10-22)). Written 2026-10-22 for lane FG1; numbers below are from the commits named, on the frozen sets in `docs/benchmarks/`.

## Where it shows up

- `refit deadlines` and `scanDeadlines`: quoted registry models in `.py` files are matched and classified like TypeScript matches (live, catalog, test, comment, tokenizer, check). Only live matches make a repository exposed, so the hosted inventory (`findDeadlineExposures`) reports Python call sites too.
- `refit deadlines --propose-model-fixes` and `proposeModelReplacements`: every traced Python request that sends a retiring model is a stop with a reason; every other live Python match is listed as not sent by a traced request, with where it is written. Replacements and patches never include Python.
- `tracePythonModelCalls(directory)` in `pipeline/python/models.ts` returns the neutral call records (`SdkCallRecord`) for every traced call, with every literal its model can be.

## What is traced

Clients:

- `openai`: `OpenAI`, `AsyncOpenAI`, `AzureOpenAI`, `AsyncAzureOpenAI`, and the module client (`openai.chat.completions.create`, and `openai.ChatCompletion.create` from before 1.0).
- `anthropic`: `Anthropic`, `AsyncAnthropic`, and the Bedrock and Vertex AI clients (reported as platform clients).
- `google-genai`: `genai.Client()`, including `client.aio`. Report only, like every Gemini use.
- LangChain, as a named report-only pattern: `ChatOpenAI`, `AzureChatOpenAI` and `ChatAnthropic` from `langchain_openai`, `langchain_anthropic`, `langchain_community.chat_models` or `langchain.chat_models`, with their `model` or `model_name`.

A client is proven by a constructor call, an import alias, a module attribute, a class field set in any method (`self.client = OpenAI()`, or annotated `client: Anthropic`), a parameter annotated with a client class or defaulting to a client, an imported repository module's client, `with_options(...)`, or a repository function that returns a client on every path. Calls on anything else (untyped parameters, wrappers such as LangSmith's `wrap_openai`, tuple results) are not traced.

Model values are followed to literals through module constants, imported constants, class fields and class-level defaults, pydantic `Field(default=...)`, `os.getenv` and `os.environ.get` defaults, `or` fallbacks and conditionals, dictionary entries by literal key, `mapping.get("key", default)`, `argparse` defaults (`args.model`), parameter defaults (only when some caller leaves the argument out), callers' arguments in the same file and in files that import the function or class, and the return values of repository helpers (with that call's own arguments). A model in `**options` is read when the options are a dictionary literal or `dict(...)`; keys after a `**spread` win over it.

## Stops

A traced call whose model cannot be followed to a literal is kept with the reason, for example: the environment variable it reads has no default; the value comes from an expression Refit cannot trace (`settings.MODEL`, a call); it is built from an f-string or concatenation; it is imported from outside the repository; it is reassigned or unpacked; the options are spread from something Refit cannot read; a parameter no found caller passes; a caller that unpacks its arguments; a field declared without a value; a command-line option with no default; the depth limit of 8.

Reported against the registry, every Python site is a stop, with the TypeScript rule's reasons where they apply: no concrete replacement; not a text-generation call; a custom base URL or Azure deployment; a Bedrock or Vertex AI client; a reached-through source (constant, environment default, field); spread options; sampling parameters the replacement may reject; LangChain; Gemini; otherwise "Refit reports Python requests but does not edit Python code yet".

## Benchmark

Sets: `2026-10-22-python-model-repos.json` (50 repositories from GitHub code search for the three SDKs, selected by `scripts/python-models-select.mjs`) and `2026-10-22-python-langchain-repos.json` (20 repositories using `ChatOpenAI` or `ChatAnthropic`, `--langchain`). Scorer: `pipeline/python/model-benchmark.ts` (`npx tsx pipeline/python/model-benchmark.ts --root <checkouts> --output <results.json> [--labels …] [--packages …]`), tested in `model-benchmark.test.ts`.

A line is a literal that a traced call can send as its model, outside test, example, notebook and build paths. Labels list every such literal per repository (`sent`), plus checked literals that are not sent and ambiguous ones (not scored). They were made by reading the code at the pinned commit, committed before the tracer ran on those repositories. The labeller is the agent that wrote the tracer, so the labels are blind to its output there but not to its design.

| Set                                                                             | Commit  | Line precision | Line recall   | Call recall    |
| ------------------------------------------------------------------------------- | ------- | -------------- | ------------- | -------------- |
| SDK labels, 20 repositories, first run (blind)                                  | 0b3e8a6 | 40/46 (87.0%)  | 40/79 (50.6%) | 76/138 (55.1%) |
| SDK labels, after four adjudications and fixes                                  | eb781f6 | 44/45 (97.8%)  | 44/83 (53.0%) | 84/140 (60.0%) |
| Held-out, 4 repositories, labelled with the tracer frozen at 798d715, first run | b914bd2 | 1/2            | 1/15          | 3/22           |
| Held-out, same labels, after the fixes in e51b9cd                               | eb781f6 | 5/5            | 5/15          | 20/22          |
| LangChain, 10 repositories, first run (blind)                                   | a76331f | 33/48 (68.8%)  | 33/34 (97.1%) | 47/47          |
| LangChain, after the fixes in 2473f40 and eb781f6                               | eb781f6 | 33/33 (100%)   | 33/34 (97.1%) | 47/47          |

Read these honestly:

- The four adjudications (in the labels file, each with a reason) all add literals the labeller missed and the tracer found: a `moderations.create` call, an environment default and two `argparse` defaults. They can only raise measured precision; the blind first run is the conservative number.
- The fixes after each first run were made with the scored repositories in view. The held-out first run is the only measurement made with the tracer frozen; it has two reported lines, too few to estimate precision.
- The remaining false positive (Mem-alpha `memory_server.py:59`) is a constant used only to choose a branch that reads the model from the environment.
- Recall is the weak side. Misses are mostly clients Refit cannot prove (factory results through tuples, untyped parameters passed from other files, LangSmith-wrapped clients), models kept in registry dictionaries and configuration files, and vendored frameworks (lmms-eval, vlmeval) whose models flow through task configuration.

Skipped from labelling, with reasons in the labels files: four repositories over 400 candidate lines, three over the 45-minute labelling timebox (mlrbench, personas-pipeline, OneVision-Encoder) and, for LangChain, one generated repository (152 copies of the same construction) and one over the timebox.

Exposure on the frozen sets at eb781f6 with the current registry: 9 of the 50 SDK repositories send a retiring model from traced Python code (309 stops; 269 more live registry literals not sent by a traced request), and 10 of the 20 LangChain repositories (59 stops, 77 not sent by a traced request).

## Not covered

Jupyter notebooks, `.pyi` stubs, other Python SDKs (litellm, the deprecated `google-generativeai`, Vertex AI's SDK, Bedrock through boto3), raw HTTP requests, and package manifests (`requirements.txt`, `pyproject.toml`: lane FG5). Files past 2 MiB, 10,000 files or 50 MiB per repository are skipped.
