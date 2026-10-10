# Fyrden

Fyrden is an open-source, self-hostable code forge built on Cloudflare Workers, designed for both humans and AI agents.

> **Status:** early development. Nothing is usable yet.

## Goals

- **Cheap to run:** serverless on Cloudflare, so you pay for usage rather than idle servers.
- **Fast and scalable:** each repository is served by its own Durable Object, with git packs stored in R2.
- **Agents first:** agents are first-class principals with scoped tokens, an MCP server and an activity feed.
- **Familiar:** git over HTTPS, pull requests, code review, issues, and GitHub Actions-compatible CI.

## Deploying

Deploying needs a Cloudflare account with R2 and Workers Analytics Engine
enabled (each is switched on once in the dashboard) and `wrangler login`.

```sh
pnpm install
node packages/cli/src/index.ts doctor
node packages/cli/src/index.ts deploy --plan free   # or --plan paid
```

`deploy` creates the D1 databases, R2 buckets, queues and KV namespace if they
are missing, applies migrations, deploys `fyrden-api` and then `fyrden-web`,
and prints a one-time bootstrap secret for creating the first admin. A
Deploy to Cloudflare button follows once a deployment is usable end to end.

### First run

```sh
# Create the instance admin; the response holds its token (shown once).
curl -X POST "$API/v0/admin/bootstrap" \
  -H "X-Fyrden-Bootstrap-Secret: $BOOTSTRAP_SECRET" \
  -H "Content-Type: application/json" -d '{"handle": "admin"}'

# As the admin, create a user, then a token for it.
curl -X POST "$API/api/admin/users" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"handle": "alice"}'
curl -X POST "$API/api/admin/users/$USER_ID/tokens" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"expires_in_days": 30}'
```

The API is described at `$API/api/openapi.json`; MCP clients connect to `$API/mcp`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/); sign off each commit with `git commit -s`.

## Licence

[Apache License 2.0](LICENSE)
