// Ported from git.git t/t5704-protocol-violations.sh (v2.53.0): requests
// that break the protocol get an error, not a hang or a crash.
import { expect } from "vitest";
import { DELIM, pkt, postUploadPack } from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5704-protocol-violations.sh";

export const t5704: CaseFile = {
  cases: [
    {
      from,
      test: "extra delim packet in v2 ls-refs args",
      fast: true,
      async run(t) {
        await t.remotes("violation-ls-refs");
        const reply = await postUploadPack(
          t,
          "violation-ls-refs",
          pkt("command=ls-refs\n") + pkt("object-format=sha1\n") + DELIM + DELIM,
        );
        // HTTP 200 with an ERR packet: git ignores the body of an error status.
        expect(reply).toMatch(/^200 [0-9a-f]{4}ERR /);
      },
    },
    {
      from,
      test: "extra delim packet in v2 fetch args",
      fast: true,
      async run(t) {
        await t.remotes("violation-fetch");
        const reply = await postUploadPack(
          t,
          "violation-fetch",
          pkt("command=fetch\n") + pkt("object-format=sha1\n") + DELIM + DELIM,
        );
        expect(reply).toMatch(/^200 [0-9a-f]{4}ERR /);
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: ["bogus symref in v0 capabilities"],
      reason: "checks the client against a v0 server reply",
    },
  ],
};
