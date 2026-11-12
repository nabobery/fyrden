// What the blame page says of its delivery: what it is doing comes before what the API has
// finished, so a paused or failed delivery always offers its button.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Progress } from "../app/components/blame-file.js";
import type { DeliveryState } from "../app/lib/blame-delivery.js";

const state = (change: Partial<DeliveryState>): DeliveryState => ({
  ranges: [],
  commits: {},
  lines: 10,
  resolved: 10,
  unresolved: 0,
  state: "complete",
  status: "done",
  refusal: null,
  owedUntil: null,
  requests: 8,
  ...change,
});

const said = (change: Partial<DeliveryState>) =>
  renderToString(<Progress state={state(change)} onResume={() => {}} />);

describe("what the page says of its delivery", () => {
  it("offers Continue when paused, even for a blame the API has finished", () => {
    const html = said({ status: "budget" });
    expect(html).toContain(">Continue</button>");
    expect(html).toContain("10 of 10 lines worked out so far.");
    expect(html).not.toContain("Every line is attributed.");
  });

  it("offers Try again after a failure, even for a finished blame", () => {
    const html = said({ status: "failed" });
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain("Every line is attributed.");
  });

  it("says a blame is whole only once every range is in", () => {
    expect(said({ status: "running" })).not.toContain("Every line is attributed.");
    expect(said({ status: "done" })).toContain("Every line is attributed.");
    expect(said({ status: "done", resolved: 7, unresolved: 3 })).toContain(
      "3 of 10 lines couldn&#x27;t be attributed",
    );
  });

  it("says a refusal in its words", () => {
    expect(said({ status: "refused", refusal: "work_limit" })).toContain(
      "takes more reads or decoding than one request allows",
    );
  });
});
