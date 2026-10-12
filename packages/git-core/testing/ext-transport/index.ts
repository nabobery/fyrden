// A git ext:: transport that serves real git clients from Node in tests.
// Node only: it spawns processes and touches the file system.
export { FileRepo, type PushLogEntry } from "./file-repo.js";
export {
  compareIdxWithGit,
  createServerRepo,
  EXT_MAIN,
  extPushArgs,
  extRemote,
  reconstructRepo,
  type ServerRepo,
  writeExtConfig,
} from "./harness.js";
export {
  type ExtConfig,
  receivePackHandler,
  TEST_RECEIVE_PACK_CAPABILITIES,
} from "./receive-pack-handler.js";
export {
  type GitServiceHandler,
  type GitServiceHandlers,
  type GitServiceIo,
  type GitServiceName,
  serveExt,
} from "./server.js";
export { type ExportOptions, exportUploadPackRepo } from "./upload-pack-export.js";
export { uploadPackHandler } from "./upload-pack-handler.js";
export { type UploadPackRemote, uploadPackRemote } from "./upload-pack-remote.js";
export {
  type LoadedUploadPackRepo,
  materialisedKeys,
  openUploadPackRepo,
  readRequestLog,
  type UploadPackRepoState,
  type UploadPackRequestLog,
} from "./upload-pack-repo.js";
