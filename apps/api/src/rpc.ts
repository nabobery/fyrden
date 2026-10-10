import { WorkerEntrypoint } from "cloudflare:workers";
import { API_RPC_VERSION, type ApiRpcContract, type HealthResult } from "@fyrden/api-contract";
import { deepHealth } from "./health.js";

/** Service-binding entrypoint used by fyrden-web (`services[].entrypoint` = "ApiRpc"). */
export class ApiRpc extends WorkerEntrypoint<Env> implements ApiRpcContract {
  async rpcVersion(): Promise<number> {
    return API_RPC_VERSION;
  }

  healthz(meta: { requestId?: string } = {}): Promise<HealthResult> {
    return deepHealth(this.env, meta.requestId ? { requestId: meta.requestId } : {});
  }
}
