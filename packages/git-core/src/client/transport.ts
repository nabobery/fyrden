/**
 * The HTTP round trip the smart-HTTP client needs, as a port: the engine
 * never calls `fetch` itself. On Workers the implementation goes through
 * the shared outbound URL guard (no redirects followed); Node tests use a
 * plain fetch against a local server.
 */
export interface ClientRequest {
  readonly method: "GET" | "POST";
  /** Absolute URL. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface ClientResponse {
  readonly status: number;
  readonly contentType: string | null;
  /** The response body, read once. */
  readonly body: AsyncIterable<Uint8Array>;
  /** Releases a body that will not be read. */
  cancel(): Promise<void>;
}

export type HttpTransport = (request: ClientRequest) => Promise<ClientResponse>;
