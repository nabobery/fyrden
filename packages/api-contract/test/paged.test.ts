// Which operations page by `page` and `per_page` and count their items:
// their REST answers carry GitHub's `Link` header, which clients such as `gh`
// follow, and the OpenAPI document says so.
import { describe, expect, it } from "vitest";
import { pagedByTotal, takesPageNumbers } from "../src/op.js";
import { openApiDocument } from "../src/openapi.js";
import { registry } from "../src/registry.js";

const PAGED_BY_TOTAL = [
  "repos.actions.secrets.list",
  "repos.actions.organization_secrets.list",
  "orgs.actions.secrets.list",
  "orgs.actions.secrets.repos.list",
  "repos.actions.variables.list",
  "repos.actions.organization_variables.list",
  "orgs.actions.variables.list",
  "orgs.actions.variables.repos.list",
  "search.issues",
  "search.repositories",
  "users.orgs.list",
];

/** Taking `page` (only 1) beside a cursor, with no `total_count` to make a last page of. */
const PAGED_BY_CURSOR = ["notifications.list", "notifications.repo_list"];

describe("operations paged by page number", () => {
  it("count their items, unless they are paged by cursor", () => {
    expect(registry.filter(pagedByTotal).map((op) => op.id)).toEqual(
      expect.arrayContaining(PAGED_BY_TOTAL),
    );
    expect(registry.filter(pagedByTotal)).toHaveLength(PAGED_BY_TOTAL.length);
    // A new operation taking page numbers decides: a count, or a place on the cursor list.
    expect(
      registry.filter((op) => takesPageNumbers(op) && !pagedByTotal(op)).map((op) => op.id),
    ).toEqual(PAGED_BY_CURSOR);
  });

  it("document a Link header on their successful answer, and no other operation does", () => {
    const doc = openApiDocument(registry, { version: "0.0.0" }) as {
      paths: Record<
        string,
        Record<string, { operationId: string; responses: Record<string, { headers?: object }> }>
      >;
    };
    const withLink = Object.values(doc.paths)
      .flatMap((item) => Object.values(item))
      .filter((op) => Object.values(op.responses).some((r) => r.headers && "Link" in r.headers))
      .map((op) => op.operationId);
    expect(withLink.sort()).toEqual([...PAGED_BY_TOTAL].sort());
  });
});
