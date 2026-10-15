# Stripe basil move excerpts

`before.json` and `after.json` are excerpts of Stripe's published OpenAPI documents for `2025-02-24.acacia` (`stripe/openapi` tag `v1505`) and `2025-04-30.basil` (tag `v1719`). They keep the invoice and invoice-item schemas, the basil parent schemas, and the 11 invoice and invoice-item operations in [`examples/stripe-basil-moves.provider.json`](../../../examples/stripe-basil-moves.provider.json). Response schemas are unchanged. Operations keep only their `operationId`, path parameters and success response, and schemas keep only their structural keywords.

Tests check the example adapter's moves against these real shapes. The excerpt omits other components, so it is not a complete contract.
