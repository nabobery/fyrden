import type { Read } from "../components/pull-checks.js";
import type { ApiResult } from "./api.server.js";

/** A read the page can do without: any failure, thrown or answered, leaves its part out. */
export async function optionalRead<T>(read: () => Promise<ApiResult<T>>): Promise<Read<T>> {
  try {
    const result = await read();
    return result.status === 200 ? { state: "read", body: result.body } : { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}
