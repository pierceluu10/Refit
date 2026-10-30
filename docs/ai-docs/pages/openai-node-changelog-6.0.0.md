## 6.0.0 (2025-09-30)

Full Changelog: [v5.23.2...v6.0.0](https://github.com/openai/openai-node/compare/v5.23.2...v6.0.0)

### ⚠ BREAKING CHANGES

* **api:** `ResponseFunctionToolCallOutputItem.output` and `ResponseCustomToolCallOutput.output` now return `string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>` instead of `string` only. This may break existing callsites that assume `output` is always a string.

### Features

* **api:** Support images and files for function call outputs in responses, BatchUsage ([abe56f8](https://github.com/openai/openai-node/commit/abe56f86afdf28fc1a1b410ace1dd422672361a7))


### Chores

* compat with zod v4 ([#1658](https://github.com/openai/openai-node/issues/1658)) ([94569a0](https://github.com/openai/openai-node/commit/94569a07ce55317b0166e742b90a463df0f70e56))

