import type { createStatus, Output } from "@fyrden/api-contract";
import type { StatusRecord } from "../do/repo/checks.js";

export function statusOutput(status: StatusRecord): Output<typeof createStatus> {
  return {
    id: status.id,
    state: status.state,
    context: status.context,
    description: status.description,
    target_url: status.targetUrl,
    created_at: status.createdAt,
    updated_at: status.createdAt,
    creator: { id: status.creator },
  };
}
