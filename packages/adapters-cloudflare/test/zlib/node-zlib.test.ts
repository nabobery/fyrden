import { describeZlibContract } from "@fyrden/git-core/testing";
import { createWorkersZlib } from "../../src/zlib/node-zlib.js";

describeZlibContract("node:zlib in workerd", async () => createWorkersZlib());
