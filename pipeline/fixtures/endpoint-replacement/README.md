# Simulated endpoint migration fixture

This fixture is a fictional catalog API and SDK, used to test Refit's generic configured endpoint replacement. It is not a real vendor integration or an announced API change. The package under `repository/simulator/catalog-sdk` is explicitly simulated and makes real HTTP requests only to the loopback simulator.

The before contract exposes `GET /legacy/items/{id}`. The after contract exposes `GET /items/{id}` with the same recorded parameters, responses and security/server shape. The TypeScript application imports a shared client and calls `items.retrieveLegacy(id, options)`. The adapter explicitly maps it to `items.retrieve(id, options)`.

The simulated SDK includes both methods; a separate test exercises a resource change to `products.get`. The HTTP checker asserts returned labels, the GET method, query/header options and 404 error propagation. Original code passes before and fails after; Refit's patch passes after. No SDK dependency or test is changed by the migration.

See [the full local reproduction](../../../docs/ENDPOINT-MIGRATIONS.md). No credentials or `npm install` are needed. Normal checks create and clean up their own local SDK link, refusing an existing `node_modules` directory. Use a disposable copy when applying the patch.
