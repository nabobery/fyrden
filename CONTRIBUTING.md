# Contributing to Fyrden

Thanks for helping. Fyrden is early; issues that describe a problem or a use
case are as welcome as pull requests. Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

## Licence and sign-off

Fyrden is licensed under the [Apache License 2.0](LICENSE). Contributions are
accepted under the same licence (inbound = outbound): by contributing, you
license your contribution under Apache-2.0.

Every commit must carry a [Developer Certificate of Origin](https://developercertificate.org/)
sign-off from its author:

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it, using the name and email from your git config; the
email must match the commit's author email. CI checks every commit in a pull
request, merge commits included, and fails if one is missing (except in
Dependabot's pull requests: a bot cannot certify the DCO). To fix a branch,
run `git rebase --signoff main` and force-push. Update a branch by rebasing,
not by merging `main` into it.

There is no CLA.

## Workflow

1. Open or find an issue for anything non-trivial, so the approach can be
   agreed first.
2. Branch from `main`, keep the change focused, and follow `AGENTS.md`.
3. Run `pnpm lint`, `pnpm turbo run typecheck test` and, for Worker changes,
   `pnpm turbo run deploy:dry-run` before pushing.
4. Open a pull request that explains what changed and why. CI must be green and
   a maintainer must approve it.

## Development setup

- Node 24 (see `.nvmrc`) and pnpm 12 (`corepack enable`; the exact version is pinned in `package.json`).
- `pnpm install`, then the commands in `AGENTS.md`.
- Deploying to your own account: `node packages/cli/src/index.ts doctor`, then
  `node packages/cli/src/index.ts deploy --plan free|paid`. R2 and Workers
  Analytics Engine must be enabled on the account first.

## Reporting security issues

Do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository; see [SECURITY.md](SECURITY.md).
