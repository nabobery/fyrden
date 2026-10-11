import { describeCommitGraphContract } from "../../testing/contracts/commit-graph.js";
import { createMemoryCommitGraph } from "../../testing/fakes/memory-commit-graph.js";

describeCommitGraphContract("in-memory", async () => {
  const graph = createMemoryCommitGraph();
  return { graph, promote: (uploadId) => graph.promote(uploadId) };
});
