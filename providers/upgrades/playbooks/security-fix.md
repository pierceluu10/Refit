---
provider: upgrades
kind: security-fix
reviewed: false
drafted: 2026-11-06
sources:
  - https://osv.dev/
  - https://ossf.github.io/osv-schema/
  - https://docs.github.com/en/code-security/security-advisories/working-with-global-security-advisories-from-the-github-advisory-database/about-the-github-advisory-database
  - https://docs.npmjs.com/cli/v11/commands/npm-audit
  - https://github.com/pypa/pip-audit
---

These tasks reach you when an advisory's fix needs more than a patch bump: the fix sits across a major, or the code itself uses the vulnerable feature. Two questions come first. Does this repo actually resolve an affected version? Does it reach the affected path?

**What usually breaks.** A fix crossing a major brings the usual breaking changes (see the dependency-major notes). Security fixes also tighten behaviour on purpose: stricter parsing, rejected inputs, safer defaults. Callers that relied on the old leniency then fail at runtime.

**How to spot it in code.** Read the lockfile to find the resolved version, including transitive copies; the manifest alone can mislead. Read the advisory's affected versions: [OSV records](https://ossf.github.io/osv-schema/) give `introduced`, `fixed` and `last_affected` events per package. Then grep for the function or option the advisory names and read how untrusted input reaches it.

**What to check.**

- The advisory itself, on [OSV](https://osv.dev/) or the [GitHub Advisory Database](https://docs.github.com/en/code-security/security-advisories/working-with-global-security-advisories-from-the-github-advisory-database/about-the-github-advisory-database). GitHub-reviewed advisories have been checked for validity; unreviewed ones arrive automatically from the NVD feed.
- `registry_diff` and `migration_guide` for what the fixed version changes.
- `end_of_life`, when the fix means leaving an unsupported line.
- [`npm audit`](https://docs.npmjs.com/cli/v11/commands/npm-audit) or [`pip-audit`](https://github.com/pypa/pip-audit) in the sandbox after the change, to confirm the advisory is gone. Run the repo's checks before and after.
- A test that exercises the fixed path, when the repo's setup makes one cheap. Never put a working exploit in the PR.

**Common pitfalls.**

- `npm audit fix --force` installs [SemVer-major updates](https://docs.npmjs.com/cli/v11/commands/npm-audit) to top-level dependencies. It can be the right move, but read what it changed.
- A transitive copy that stays vulnerable. Upgrade the parent where you can; if you add an override, say so in the PR, since nothing tests that the parent works with it.
- Assuming "not reachable" from a quick grep. Dynamic calls and framework wiring hide paths. If you conclude a repo isn't affected, give the reasoning and what you read so a person can check it.
- Mixing in unrelated upgrades. A focused diff gets reviewed and merged faster.
- Malware advisories are different in kind: GitHub lists [malicious packages](https://docs.github.com/en/code-security/security-advisories/working-with-global-security-advisories-from-the-github-advisory-database/about-the-github-advisory-database) too. Upgrading doesn't undo an install that already ran, so flag possible credential rotation for a person.

**When you're unsure.** Apply the fix anyway and state plainly what you could and couldn't prove about exposure. Write nothing in the PR that helps an attacker beyond what the public advisory says.
