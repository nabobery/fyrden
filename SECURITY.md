# Security policy

## Supported versions

Fyrden is in early development and has no releases yet. Security fixes land
on `main` only.

## Reporting a vulnerability

Do not open a public issue, pull request or discussion for a vulnerability.
Report it privately through GitHub's
[private vulnerability reporting](https://github.com/nabobery/fyrden/security/advisories/new)
on this repository.

Include what you can of:

- the affected component (`fyrden-api`, `fyrden-web`, the CLI, a package) and
  the commit or deployment you tested;
- the impact: what an attacker can read, change or run, and as whom;
- steps or a proof of concept that reproduces it;
- whether it needs a particular Cloudflare plan (Workers Free or Paid) or
  configuration.

Fyrden is maintained by one person, so responses are best effort: expect an
acknowledgement within a week. Please keep the report private until a fix is
released or we agree on a disclosure date; reporters are credited in the
advisory unless they ask not to be.

## Scope

In scope: the code in this repository and a Fyrden deployment made with its
CLI. Out of scope: Cloudflare's platform itself (report those to
[Cloudflare](https://www.cloudflare.com/disclosure/)), findings that need an
already compromised Cloudflare account or admin token, and denial of service
by volume alone.
