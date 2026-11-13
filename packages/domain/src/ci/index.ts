// Workflow files: discovery, parsing and the supported subset. A subpath of
// its own (`@fyrden/domain/ci`) so the YAML parser stays out of everything
// that imports the package root, the web app's client bundle included.
export * from "./discover.js";
