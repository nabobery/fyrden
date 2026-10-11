import {
  createMemoryBlockCache,
  createMemoryBudget,
  createMemoryRepoStore,
  describeBlockCacheContract,
  describeMemoryBudgetContract,
  describeRepoStoreContract,
} from "../../testing/index.js";

describeRepoStoreContract("in-memory", async () => createMemoryRepoStore());
describeBlockCacheContract("in-memory", async () => createMemoryBlockCache());
describeMemoryBudgetContract("in-memory", async (total) => createMemoryBudget(total));
