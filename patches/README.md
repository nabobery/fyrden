# picomatch 4.0.7 tooling mitigation

Reviewed on 2026-11-18 for [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).
No patched npm release is available. The package is used by Vitest, Vite,
tinyglobby and fdir; it is not a production dependency.

The patch backports [upstream PR 259](https://github.com/micromatch/picomatch/pull/259),
commit `d705935d4ece5f406df01213330f1a04adad3fe0`, onto 4.0.7. That proposal
is unmerged. It removes repeated unbounded stars by absorbing the repeat when
possible and otherwise using the parser's existing literal fallback. Local
scanner fixes also detect stars hidden inside nested groups, quotes inside
character classes, and unclosed brackets or quotes. Nested groups, classes with
a leading `]` or another `[` inside them, runs of four or more backslashes, and
unclosed forms use the literal fallback when a star follows. The same safeguard
covers bracketed stars with `nobracket: true` and bodies containing both a
backslash and a star with `unescape: true`. Some malformed class forms produce a non-matching expression
instead of a literal. Rewrite offsets are recorded after opening-token
normalization, so a globstar prefix cannot discard the repeated branch.
The accompanying [MIT notice](LICENSE.picomatch) applies.

This is a mitigation for repeated-star extglobs, not a guarantee that arbitrary
untrusted globs are safe. Negated repeats and raw regex syntax can still
backtrack badly. `maxExtglobRecursion: false` explicitly disables the safeguard
and remains unsafe. No installed consumer sets that option (verified by code
inspection on 2026-11-18).

Risky patterns that cannot be safely rewritten become literals. Rewritten forms
can change capture groups; globstar forms can stop matching top-level dotfiles
unless `dot` is enabled. The regression covers the affected forms, ordinary
tooling patterns and options through each real consumer's installed copy.
It checks the generated expression before evaluating long inputs, so removing
the mitigation fails without blocking the test process.

The version-specific `patchedDependencies` entry and lockfile hash bind the
installation to this patch. Missing or unused patches must fail installation;
do not enable `allowUnusedPatches`. The audit exception is limited to this GHSA
because the registry sees the unchanged package version, not the local patch.
Other high and critical advisories still fail CI.

Remove the patch and exception together after verifying an eligible upstream
release outside the advisory range, or reassess both if GitHub withdraws this
advisory. Snyk's separate withdrawal does not remove GitHub's active finding.
