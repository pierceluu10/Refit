# Reviewing Refit's fixes by hand

Passing checks show the migrated code still typechecks or passes its tests. They don't show the fix is right. Most benchmark repositories have no tests, so every published draft gets a human review, recorded in [`benchmarks/fix-reviews.json`](benchmarks/fix-reviews.json). The benchmark report counts verdicts, not only passing checks.

## Checklist

Answer each for the draft PR, with a one-line note:

1. **Right replacement:** the new code reads what Stripe's changelog names as the replacement for each removed field.
2. **Both versions:** the code still works for events and responses rendered in the old API version.
3. **Nothing unrelated:** no change outside the removed-field reads, imports, the generated helper and the version pin.
4. **Please-check items:** each listed read is either a real gap or correctly left alone; note false alarms.
5. **Upgrade complete:** the `apiVersion` pin and `stripe` package are moved to the target version, or the PR says they are not.
6. **Would merge:** a maintainer could merge it as is.

## Verdicts

- `correct`: 1 to 4 and 6 hold.
- `correct-partial`: the changed code is right, but something needed for the upgrade is missing (usually 5).
- `wrong`: any changed line reads the wrong field, breaks old-version handling, or changes unrelated behavior.
- `unsure`: the reviewer cannot tell without running the application; say what would settle it.

A `wrong` verdict is a Refit bug: add a test case that reproduces it.
