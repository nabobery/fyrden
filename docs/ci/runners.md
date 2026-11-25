# Self-hosted runners

An organization's Actions jobs run on machines you bring, with the stock
[gitea/runner](https://gitea.com/gitea/runner), v6.0.0 or v5.4.1. Forks of it are untested.
The numbers (rates, sizes, the Free fleet) are in [limits](../operations/limits.md) under "CI runners"
and "CI capacity".

What this page says of the runner itself was verified by inspecting its source at v6.0.0 and v5.4.1,
linked where it is said; none of those statements was checked by running it unless noted.

## Register a runner

Only an organization's owners register runners, choose what they run and delete them. A repository's
administrators cannot, and a user account has no runners.

1. Open the organization's settings, then Runners, then New runner. Choose which jobs the runner takes
   (below) and create the token. It registers one runner, within the hour.
2. On the machine, save the [configuration](#runner-configuration) below as `config.yaml`. The runner
   reads no configuration it is not given
   ([v6.0.0](https://gitea.com/gitea/runner/src/tag/v6.0.0/internal/app/cmd/cmd.go),
   [v5.4.1](https://gitea.com/gitea/runner/src/tag/v5.4.1/internal/app/cmd/cmd.go)).
3. Run the command the page shows, with your labels, then start the runner with that configuration:

   ```sh
   gitea-runner register --config config.yaml --no-interactive --instance https://forge.example \
     --token TOKEN --ephemeral --labels ubuntu-latest:docker://docker.gitea.com/runner-images:ubuntu-latest
   gitea-runner daemon --config config.yaml
   ```

   Leave out `--ephemeral` for a long-lived runner. A token that allows fork pull requests registers
   only an ephemeral runner; a Register without the flag is refused and does not spend the token.

The same is available as `POST /orgs/{org}/actions/runners/registration-token`.

An ephemeral runner takes one job. Its daemon exits after it (measured with both versions), and the server gives its credential no
other job, whatever else asks with it. For a steady supply, have something else start a machine,
register it and throw it away. An ephemeral runner registered again on the same machine is a new
runner, not a new machine.

## Which jobs a runner takes

The server decides, for each job, from the runner's access. Labels (`runs-on`) only narrow the choice:
a workflow picks its own labels, so they protect nothing.

| Job | Private or internal repository | Public repository |
|---|---|---|
| `push`, `schedule`, `workflow_dispatch`, a pull request from the same repository | any runner | `allows_public` |
| A pull request from a fork: `pull_request` and `pull_request_target` | `allows_forks` | `allows_forks` and `allows_public` |

| Field | Default | What it does |
|---|---|---|
| `repository_access` | `all` | `all` of the organization's repositories, or `selected` ones (100 at most) |
| `allows_public` | off | takes public repositories' jobs |
| `allows_forks` | off | takes fork pull requests' jobs; ephemeral runners only |

A fork's run that needs a maintainer's approval still needs it: approval and access are separate.
`pull_request_target` needs `allows_forks` too. It runs the base repository's workflow with its
secrets, and such a workflow may check out and run the fork's code.

Change access on the runner's page, or with
`PATCH /orgs/{org}/actions/runners/{runner_id}/access`. What it changes, and when:

- **Narrowing** applies at the next claim, and whenever a job is offered to the runner again. An
  assignment that already passed that check may still be delivered. If it was recorded
  but the runner never received it, the job is not given to another runner: unless another timeout or a
  cancellation ends it first, it fails at its heartbeat deadline, normally about ten minutes after the
  assignment. Running jobs continue: to end one, force-cancel its run (an ordinary cancellation lets jobs with `if: always()`
  run), or stop the machine.
- **Widening** lets the runner take jobs already offered at once. A job that waited because no runner
  could take it is offered within five minutes.
- **A repository transferred** to another account leaves every runner's list and every unused token's.
  Moved back, it is not listed again.
- **A repository made public:** later claims and re-offers of its jobs need `allows_public`.

Every change, registration and deletion is in the audit log.

## Public repositories and forks

Job code can do anything the job's container can, and often anything the machine can (next section).
Plan for that:

- **Use a fresh machine for every ephemeral runner.** The server sees a registration, not a machine. A
  reused machine can carry images, volumes, caches and anything a job left running into the next,
  trusted, job.
- **Keep runners that take public or fork jobs away from everything else:** their own machines, a
  network with no route to internal services or to a cloud provider's metadata address, and no
  credentials on disk.
- **Avoid `allows_public` on a long-lived runner that also takes private jobs.** Only people who can
  write to the public repository start its jobs, but those jobs may run unpinned actions, new versions
  of dependencies, or text anyone can submit (a title, a comment). A compromised long-lived runner
  stays compromised for the private job it takes next. Prefer an ephemeral runner, or a runner limited
  to the public repositories (`selected`). GitHub's advice is stronger: self-hosted runners "should
  almost never be used for public repositories"
  ([secure use](https://docs.github.com/en/actions/reference/security/secure-use)).

## Runner configuration

Set these in the runner's `config.yaml` on every runner that takes public or fork jobs, and preferably
on all of them.

```yaml
runner:
  capacity: 1
cache:
  enabled: false
container:
  docker_host: "-"
  privileged: false
  valid_volumes: []
  network: ""
```

| Setting | Why |
|---|---|
| `container.docker_host: "-"` | Left empty, the runner mounts the host's Docker socket into job containers, whatever `valid_volumes` says (`containerDaemonSocket` and `validVolumes` in `run_context.go`: [v6.0.0](https://gitea.com/gitea/runner/src/tag/v6.0.0/act/runner/run_context.go), [v5.4.1](https://gitea.com/gitea/runner/src/tag/v5.4.1/act/runner/run_context.go)). A job that reaches the socket controls the machine and can read the runner's credential |
| `container.privileged: false` | The default ([example configuration](https://gitea.com/gitea/runner/src/tag/v6.0.0/internal/pkg/config/config.example.yaml), for this and the rows below). Privileged containers are not isolated from the host |
| `container.valid_volumes: []` | The default. Mounts a workflow asks for are refused, but for those the runner makes itself and any in `container.volumes` |
| `container.network: ""` | The default. Each job gets its own Docker network, which `services:` need; a shared network lets one job reach another |
| `cache.enabled: false` | A shared cache is a path from a fork's job to a later, trusted one. Or run one cache per level of trust, and never share it between runners that take fork jobs and runners that don't |
| `runner.capacity: 1` | The default. Jobs at the same time on one machine share its Docker daemon |

With the cache off nothing is restored or saved: a workflow that requires a cache hit fails.

### Labels, `services:` and `container:`

- A `docker://` label runs the job in that image. A `host` label runs it on the machine itself, with
  the runner's own rights: never use one for public or fork jobs.
- A job on a `host` label starts no `services:` containers, and reports no error
  (`startHostEnvironment` in `run_context.go`, linked above; not checked by running it). A job with
  `container:` is a Docker job whatever the label.
- The server sees only the label's name, not how the runner runs it, so it cannot check any of this.

## Capacity

- Each runner takes as many jobs at once as its `capacity`. More runners take jobs in parallel; the
  oldest job a runner may take goes first.
- **Free deployments:** a small number of runners serve the whole deployment (2 unless
  `FYRDEN_CI_FLEET` says otherwise), each with a daily polling budget, and jobs share a daily
  allowance. An idle runner costs Worker requests whether or not there is work, so delete those you
  don't use. A runner that spends its daily polling budget is revoked: keep the default `fetch_interval`
  and `fetch_interval_max`, or slower ones where the deployment's budget is lower.
- The runner list shows when a runner registered and why one ended, not whether it is connected: the
  server does not store it. Look at the runner's own log for that.

## If a runner's credential may have leaked

Delete the runner, on its page or with `DELETE /orgs/{org}/actions/runners/{runner_id}`: every later call
with its credential is refused. That does not stop a job it is running, because the runner retries
refused reports without stopping the job
([v6.0.0](https://gitea.com/gitea/runner/src/tag/v6.0.0/internal/pkg/report/reporter.go),
[v5.4.1](https://gitea.com/gitea/runner/src/tag/v5.4.1/internal/pkg/report/reporter.go)). Stop and discard
the machine.

When nothing has leaked, force-cancel the run and see that its job has stopped before you delete the runner: a
deleted runner is never told of the cancellation. Or stop the machine.

A registration token that was never used stops working an hour after it was made.
