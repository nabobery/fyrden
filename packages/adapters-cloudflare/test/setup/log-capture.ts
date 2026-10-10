import { installLogCapture } from "@fyrden/testing/log-capture";

// Every integration test fails if any log line holds an unredacted token.
export const logs = installLogCapture();
