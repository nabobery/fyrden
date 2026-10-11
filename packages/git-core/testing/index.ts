// Test support for code that uses git-core's ports: in-memory fakes and the
// contract suites every adapter must pass. Not part of the engine. The git
// ext:: transport used by Node tests is in "@fyrden/git-core/testing/ext-transport".
export { describeBlockCacheContract } from "./contracts/block-cache.js";
export {
  type CommitGraphUnderTest,
  describeCommitGraphContract,
} from "./contracts/commit-graph.js";
export { describeMemoryBudgetContract } from "./contracts/memory-budget.js";
export { describeRepoStoreContract } from "./contracts/repo-store.js";
export { describeZlibContract } from "./contracts/zlib.js";
export { createMemoryBlockCache } from "./fakes/memory-block-cache.js";
export { createMemoryBudget } from "./fakes/memory-budget.js";
export {
  createMemoryCommitGraph,
  type MemoryCommitGraph,
} from "./fakes/memory-commit-graph.js";
export { createMemoryRepoStore, type MemoryRepoStore } from "./fakes/memory-repo-store.js";
export { createNodeZlib } from "./node-zlib.js";
