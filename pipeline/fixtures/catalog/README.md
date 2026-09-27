# Configurable SDK fixture

This is a synthetic catalog API and SDK, not an integration with a real vendor. No package named `@example/catalog` is installed or contacted by the offline scan.

The adapter maps `items.retrieve` to the `item` schema and `orders.retrieve` to `order`. Both schemas originally have `legacy_label`, but only `item` loses it. The source reads the field from both responses. A correct scan flags only the item read.

```sh
npm run api:scan -- --provider-config pipeline/fixtures/catalog/provider.json --repository pipeline/fixtures/catalog/repository --before pipeline/fixtures/catalog/before.json --after pipeline/fixtures/catalog/after.json --propose-patch
```

Expected: one confirmed finding under the configured mapping, provider `catalog-example`, and no deterministic patch. Controlled-response tests also exercise AI generation and rescanning for this adapter. The example's apparent rename is synthetic; an added property does not prove that it replaces a removed property with equivalent semantics.
