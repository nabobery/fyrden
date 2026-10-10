import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
