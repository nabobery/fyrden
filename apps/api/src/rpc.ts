import { WorkerEntrypoint } from "cloudflare:workers";
import { API_RPC_VERSION, type ApiRpcContract, type HealthResult } from "@fyrden/api-contract";
import { app } from "./app-instance.js";
import { deepHealth } from "./health.js";

/** Service-binding entrypoint used by fyrden-web (`services[].entrypoint` = "ApiRpc"). */
export class ApiRpc extends WorkerEntrypoint<Env> implements ApiRpcContract {
  async rpcVersion(): Promise<number> {
    return API_RPC_VERSION;
  }

  healthz(meta: { requestId?: string } = {}): Promise<HealthResult> {
    return deepHealth(this.env, meta.requestId ? { requestId: meta.requestId } : {});
  }

  /**
   * HTTP over the binding: fyrden-web serves the API's paths on its own
   * origin (one origin for browsers, git and MCP clients) by handing them
   * here unchanged.
   */
  override fetch(request: Request): Promise<Response> {
    return Promise.resolve(app.fetch(request, this.env, this.ctx));
  }
}
