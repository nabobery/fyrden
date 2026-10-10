# Fyrden

Fyrden is an open-source, self-hostable code forge built on Cloudflare Workers, designed for both humans and AI agents.

> **Status:** early development. Nothing is usable yet.

## Goals

- **Cheap to run:** serverless on Cloudflare, so you pay for usage rather than idle servers.
- **Fast and scalable:** each repository is served by its own Durable Object, with git packs stored in R2.
- **Agents first:** agents are first-class principals with scoped tokens, an MCP server and an activity feed.
- **Familiar:** git over HTTPS, pull requests, code review, issues, and GitHub Actions-compatible CI.

## Contributing

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/). Sign off each commit with `git commit -s`.

## Licence

[Apache License 2.0](LICENSE)
