# Runner payload harness

Checks Fyrden's job payloads with the parser and evaluator that gitea/runner
v6.0.0 links: `gitea.dev/actionslib` v1.5.2
(`h1:PSSUd+4jIjI+ycqo62+BRgAWkBnzjgeGQAcI3ZqH7LY=`, the hash in the runner's
`go.sum`). Each payload is read as `internal/app/run/workflow.go` reads it, and
its matrix, name and labels evaluated as `act/runner/runner.go` does, with a
secret set, so a string the runner evaluated a second time would show.

Not part of CI, which has no Go toolchain. Run it after changing
`src/ci/payload.ts` or the expression quoting it uses, from the repository root:

```sh
dir=$(mktemp -d)
FYRDEN_RUNNER_HARNESS="$dir" pnpm --filter @fyrden/domain exec vitest run test/ci/payload.runner-harness
(cd packages/domain/test/ci/fixtures/runner/harness && go run . "$dir")
```

The cases live in `test/ci/payload.runner-harness.test.ts`, which also checks
them on the TypeScript side in every run. Each case is written as
`<name>.payload.json` and `<name>.expect.json`; the harness prints one line per
case and exits non-zero if the runner reads any differently.
