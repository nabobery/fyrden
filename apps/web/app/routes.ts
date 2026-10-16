import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("healthz", "routes/healthz.ts"),
  route("sign-out", "routes/sign-out.ts"),
  route("settings/tokens", "routes/settings.tokens.tsx"),
  route("settings/agents", "routes/settings.agents.tsx"),
  route(":owner/:repo", "routes/repo.tsx"),
  route(":owner/:repo/tree/:ref/*", "routes/repo.tree.tsx"),
  route(":owner/:repo/blob/:ref/*", "routes/repo.blob.tsx"),
  route(":owner/:repo/edit/:ref/*", "routes/repo.edit.tsx"),
  route(":owner/:repo/raw/:ref/*", "routes/repo.raw.ts"),
  route(":owner/:repo/archive/:format", "routes/repo.archive.ts"),
  route(":owner/:repo/commits", "routes/repo.commits.tsx"),
  route(":owner/:repo/pulls", "routes/repo.pulls.tsx"),
  route(":owner/:repo/pull/:number", "routes/repo.pull.tsx"),
  route(":owner/:repo/pull/:number/files", "routes/repo.pull.files.tsx"),
  route(":owner/:repo/pull/:number/files/patches", "routes/repo.pull.patches.ts"),
  route(":owner/:repo/settings", "routes/repo.settings.tsx"),
] satisfies RouteConfig;
