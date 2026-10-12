// Types for the part of `node:async_hooks` this package uses. The package
// does not depend on @types/node, whose Node globals do not exist in
// Workers; the runtime module comes from workerd's Node.js compatibility
// (AsyncLocalStorage, verified:
// https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/).
// Signatures follow the Node.js docs (nodejs.org/api/async_context.html).
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
