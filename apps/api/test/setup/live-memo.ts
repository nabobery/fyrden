// What one test's refusal left in this isolate's memory is not the next test's.
import { beforeEach } from "vitest";
import { liveRefusalMemo } from "../../src/live/refusal-memo.js";

beforeEach(() => liveRefusalMemo.clear());
