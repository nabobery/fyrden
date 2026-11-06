import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";

/** A worker for the renderers' pool: only a bundler can make this import, never a Node test. */
export const newPoolWorker = () => new DiffsWorker();
