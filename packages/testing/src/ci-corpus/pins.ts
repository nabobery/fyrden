/**
 * What the runner tier's workflows run, by commit or digest. An upgrade is a dedicated change,
 * as for any pinned dependency.
 */
export const ACTION_PINS = [
  { action: "actions/checkout", tag: "v7.0.1", commit: "3d3c42e5aac5ba805825da76410c181273ba90b1" },
  { action: "actions/cache", tag: "v6.1.0", commit: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9" },
  { action: "actions/cache", tag: "v4.3.0", commit: "0057852bfaa89a56745cba8c7296529d2fc39830" },
] as const;

/** Multi-platform index digests, read with `docker buildx imagetools inspect` on 2026-11-28. */
export const IMAGE_PINS = {
  job: "node:24@sha256:49f7adaf9f1574bc45c20ea317139b39a59d7e758d0e93745e112fd85cb42623",
  service: "redis:7-alpine@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe",
  dockerStep:
    "busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec",
} as const;
