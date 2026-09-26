# Frontend verification

This records frontend checks only. It is not evidence that the backend MVP in the PRD is implemented.

## Automated behavior tests

All 16 tests pass. `npm test` covers:

- Manual walkthrough selection interrupts autoplay.
- Autoplay completes once and can be replayed.
- Reduced-motion users do not get autoplay; unmount clears timers.
- Failed validation blocks the example PR view.
- Unaffected usage produces no example migration.
- Repository filters update the URL and survive browser-back navigation.
- Empty repository search can be cleared.
- Run-detail tabs support direct links and retain failed-state behavior.
- Unknown demo scenarios fall back to a valid default.
- Mobile drawer focus is contained, Escape closes it, and focus returns to the trigger.
- Missing resource addresses offer a recovery route.
- Configuration export matches the chosen manager, checks, and attempt limit.
- Invalid validation configuration is rejected.
- Clipboard success and permission-denied recovery are reported correctly.

`npm run build` checks TypeScript and generates the production assets. `npm run format:check` checks source formatting.

## Browser inspection

The available browser tool's Playwright interface was used to inspect the actual running frontend, including desktop and phone layouts, workflow controls, repository search, empty-result recovery, run validation details, and the configuration builder. A separate Playwright MCP server was not available.

The final responsive pass checked eight routes at 320, 768, and 1440 pixels wide (24 combinations). All retained a main heading and landmark without document-level horizontal overflow.

No live Stripe call, GitHub mutation, sandbox command, or migration backend was involved. The project test suite's passing results must not be confused with the illustrative validation results displayed inside the product demo.

## Hosting requirements

The production output is a static SPA. A host must serve `index.html` for client-side routes and serve generated assets normally. No production deployment was performed.
