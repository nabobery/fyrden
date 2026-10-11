import { describeZlibContract } from "../../testing/contracts/zlib.js";
import { createNodeZlib } from "../../testing/node-zlib.js";

describeZlibContract("node:zlib", async () => createNodeZlib());
