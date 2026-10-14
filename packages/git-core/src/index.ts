export {
  DEFAULT_FETCH_CLIENT_LIMITS,
  FetchClientError,
  type FetchClientErrorCode,
  type FetchClientLimits,
  type FetchClientOptions,
  type FetchPackOptions,
  type FetchPackSink,
  type LsRefsRequest,
  parseLsRefsLine,
  type RemoteRef,
  SmartHttpClient,
} from "./client/fetch-client.js";
export type { ClientRequest, ClientResponse, HttpTransport } from "./client/transport.js";
export { BitSet } from "./graph/bitset.js";
export { addPendingCommits } from "./graph/commit-graph.js";
export type { WalkOptions } from "./graph/commit-walk.js";
export { MissingCommitError, WalkLimitError } from "./graph/errors.js";
export {
  computeGenerations,
  correctedCommitDate,
  correctedDateOffset,
  GENERATION_DATE_MAX,
  GENERATION_V1_MAX,
  GENERATION_V2_OFFSET_MAX,
  type Generations,
  topologicalLevel,
} from "./graph/generation.js";
export { mergeBases } from "./graph/merge-base.js";
export {
  type MarkOutside,
  type MarkSource,
  ObjectMark,
  type ObjectMarkOptions,
} from "./graph/object-mark.js";
export { OidTable } from "./graph/oid-table.js";
export {
  canAllFromReach,
  isAncestor,
  markPositions,
  reachableCommits,
} from "./graph/reachability.js";
export {
  createSha1Hasher,
  Sha1,
  Sha1CollisionError,
  type Sha1Options,
} from "./hash/sha1.js";
export { type Commit, encodeCommit, parseCommit } from "./object/commit.js";
export {
  FSCK_SEVERITY,
  type FsckIssue,
  type FsckMessageId,
  type FsckSeverity,
  GitObjectError,
  type Parsed,
} from "./object/fsck.js";
export type { Header } from "./object/headers.js";
export type { Ident } from "./object/ident.js";
export {
  encodeObjectHeader,
  hashObject,
  isObjectType,
  OBJECT_TYPES,
  type ObjectType,
} from "./object/object.js";
export {
  compareOids,
  isZeroOid,
  OID_BYTES,
  OID_HEX_LENGTH,
  type Oid,
  oidEquals,
  oidFromBytes,
  oidFromHex,
  oidToHex,
  parseOidHex,
  zeroOid,
} from "./object/oid.js";
export { encodeTag, parseTag, type Tag } from "./object/tag.js";
export {
  compareTreeEntries,
  encodeTree,
  FILE_MODES,
  isTreeMode,
  parseTree,
  type TreeEntry,
  treeEntries,
} from "./object/tree.js";
export { applyDelta, type DeltaHeader, readDeltaHeader } from "./pack/delta-apply.js";
export {
  decodeEntryHeader,
  decodePackHeader,
  ENTRY_TYPE_CODES,
  type EntryHeader,
  type EntryHeaderFields,
  type EntryKind,
  encodeEntryHeader,
  encodePackHeader,
  PACK_HEADER_BYTES,
  PACK_TRAILER_BYTES,
  type PackHeader,
} from "./pack/entry-header.js";
export { PackError, type PackErrorCode } from "./pack/errors.js";
export {
  DEFAULT_FALSE_POSITIVE_RATE,
  EXISTENCE_FILTER_VERSION,
  ExistenceFilterError,
  type ExistenceFilterErrorCode,
  MAX_FILTER_CHUNK_BYTES,
  OidBloomFilter,
} from "./pack/existence-filter.js";
export { PackExistenceSummary } from "./pack/existence-summary.js";
export {
  decodeFanout,
  encodeFanout,
  IDX_FANOUT_BYTES,
  IdxError,
  type IdxErrorCode,
} from "./pack/idx-format.js";
export {
  type IdxRangeReader,
  type OpenRangedIdxOptions,
  openRangedIdx,
  RangedPackIdx,
} from "./pack/idx-range-read.js";
export { type IdxEntry, type IdxLookup, type IdxReadBudget, PackIdx } from "./pack/idx-read.js";
export {
  type IdxWriteInput,
  type IdxWriteOptions,
  type WrittenIdx,
  writeIdx,
} from "./pack/idx-write.js";
export { ENTRY_RECORD_BYTES, type PackEntries } from "./pack/index-state.js";
export {
  DEFAULT_PACK_LIMITS,
  type ExternalBaseLookup,
  type PackLimits,
  type PackObject,
  type PackRangeReader,
  type ParsedPack,
  type ParsePackOptions,
  parsePack,
} from "./pack/parse.js";
export { decodeDeltaSize, encodeDeltaSize } from "./pack/varint.js";
export {
  Compaction,
  type CompactionOptions,
  type CompactionSource,
  compactPacks,
  DEFAULT_COMPACTION_READ_BYTES,
} from "./pack-write/compact.js";
export { PackWriteError, type PackWriteErrorCode } from "./pack-write/errors.js";
export {
  type CopiedEntry,
  DEFAULT_PACK_CHUNK_BYTES,
  type DeltaBase,
  type FinishedPack,
  PackBuilder,
  type PackBuilderOptions,
  type PackBuilderResumeOptions,
  type PackSink,
} from "./pack-write/pack-builder.js";
export {
  DEFAULT_FRAMED_OUTPUT_BYTES,
  frameSidebandData,
  type SidebandFrameOptions,
  sidebandFramedLength,
} from "./pack-write/sideband-frame.js";
export { type PackSizeReport, packSizeReport, type SizeTally } from "./pack-write/size-report.js";
export {
  DEFAULT_RANGE_BYTES,
  DEFAULT_STITCH_CHUNK_BYTES,
  duplicateObjectCount,
  type PackRangeStream,
  type PackSegment,
  planVerbatimPack,
  rangeStreamFromStore,
  type StreamVerbatimOptions,
  streamVerbatimPack,
  type VerbatimPlan,
  type VerbatimSource,
} from "./pack-write/verbatim.js";
export type { PackRangeRead } from "./pack-write/window-reader.js";
export { BLOCK_SIZE, type BlockCache } from "./ports/block-cache.js";
export type {
  CommitGraph,
  CommitGraphEntry,
  CommitGraphRow,
  CommitGraphView,
  CommitInfo,
} from "./ports/commit-graph.js";
export type { Hasher, HasherFactory, ResumableHasher } from "./ports/hasher.js";
export type { MemoryBudget, MemoryReservation } from "./ports/memory-budget.js";
export {
  asPackId,
  isPackId,
  type PackId,
  type PackInfo,
  type PackStore,
  type PackWriter,
} from "./ports/pack-store.js";
export type {
  RefCommitRequest,
  RefCommitResult,
  ReflogEntry,
  RefSnapshot,
  RefStore,
  RefUpdate,
} from "./ports/ref-store.js";
export type { Signer } from "./ports/signer.js";
export { type InflateResult, type Zlib, ZlibError, type ZlibErrorKind } from "./ports/zlib.js";
export {
  type AdvertisedRef,
  type Capability,
  encodeCapabilityList,
  encodeRefAdvertisement,
  encodeV2CapabilityAdvertisement,
  findCapability,
  parseCapabilityList,
  type RefAdvertisement,
  readRefAdvertisement,
  readV2CapabilityAdvertisement,
} from "./protocol/capabilities.js";
export { ProtocolError, type ProtocolErrorCode } from "./protocol/errors.js";
export {
  chompLf,
  DEFAULT_PKT_LINE_LIMITS,
  delimPkt,
  encodePktLine,
  flushPkt,
  MAX_PKT_DATA_LENGTH,
  MAX_PKT_LINE_LENGTH,
  type PktLine,
  type PktLineLimits,
  PktLineReader,
  type PktLineSource,
  PktLineStreamReader,
  PktLineWriter,
  responseEndPkt,
} from "./protocol/pktline.js";
export {
  DEFAULT_RECEIVE_PACK_LIMITS,
  encodeReceivePackRequest,
  type PushCommand,
  type ReceivePackRequest,
  type ReceivePackRequestOptions,
  readReceivePackRequest,
} from "./protocol/receive-pack-request.js";
export {
  decodeSidebandPacket,
  demultiplexSideband,
  encodeSideband,
  encodeSidebandStream,
  SIDEBAND_64K_MAX_PAYLOAD,
  SIDEBAND_DATA,
  SIDEBAND_ERROR,
  SIDEBAND_PROGRESS,
  type SidebandBand,
  type SidebandFrame,
  sidebandPackets,
} from "./protocol/sideband.js";
export {
  DEFAULT_FETCH_LIMITS,
  encodeV2CommandRequest,
  type FetchArgs,
  type FetchArgsOptions,
  type LsRefsArgs,
  parseFetchArgs,
  parseLsRefsArgs,
  readV2CommandRequest,
  type V2Advertised,
  type V2CommandRequest,
} from "./protocol/v2-command.js";
export { type LogPage, type LogPageOptions, logPage, type PathEntryLookup } from "./read/log.js";
export {
  type CachedObject,
  DELTA_BASE_ENTRY_OVERHEAD,
  DeltaBaseCache,
} from "./reader/delta-base-cache.js";
export { MissingObjectError } from "./reader/errors.js";
export {
  DEFAULT_READER_LIMITS,
  type ObjectHeaderInfo,
  ObjectReader,
  type ObjectReaderOptions,
  type ReaderLimits,
  type StoredObject,
  type WalkedObject,
} from "./reader/object-reader.js";
export { createReadStats, type ReadStats } from "./reader/stats.js";
export type { PackIdxSource, RepoView, ViewPack } from "./reader/view.js";
export {
  bytesBody,
  COMMAND_READ_BYTES,
  type PushBody,
  readPushBody,
  type StoredBody,
} from "./receive-pack/body.js";
export {
  type CommandKind,
  casConflict,
  DEFAULT_PUSH_POLICY,
  liveCommands,
  type PushCapabilities,
  type PushCommandState,
  type PushPlan,
  type PushPolicy,
  planPush,
} from "./receive-pack/commands.js";
export type { IndexPhase, PushTip, UnpackFailure } from "./receive-pack/cursor.js";
export {
  type FinalizeEnv,
  finalizePush,
  type PushCommitRequest,
  type PushCommitResult,
  type PushResult,
} from "./receive-pack/finalize.js";
export {
  PUSH_FSCK_SEVERITY,
  PushFsck,
  PushFsckError,
  type PushFsckFinding,
  type PushFsckId,
  type PushFsckLevel,
  type PushFsckPolicy,
} from "./receive-pack/fsck.js";
export { checkGitmodules, type GitmodulesFinding } from "./receive-pack/gitmodules.js";
export {
  DEFAULT_PUSH_LIMITS,
  type IndexOutcome,
  type PushIndexEnv,
  PushIndexer,
  type PushLimits,
} from "./receive-pack/indexer.js";
export {
  type ReceivePackOptions,
  type ReceivePackOutcome,
  receivePack,
  requestedSideband,
} from "./receive-pack/receive-pack.js";
export { type RefStoreCommitOptions, refStoreCommitter } from "./receive-pack/ref-store-commit.js";
export {
  encodeFatalError,
  encodeProgress,
  encodePushResponse,
  encodeStatusReport,
  type PushReport,
} from "./receive-pack/report.js";
export {
  type NamespaceUpdate,
  type RefNamespace,
  type RefnameConflict,
  refnameConflicts,
  refParents,
  sortedRefNamespace,
} from "./refs/namespace.js";
export { isValidRefname } from "./refs/refname.js";
export {
  MAX_SIGNATURE_BYTES,
  type SignedCommit,
  splitSignedCommit,
  verifyCommitSignature,
} from "./sign/commit-signature.js";
export {
  armorSshSignature,
  ed25519FromSeed,
  ed25519KeyOf,
  ed25519PublicKeyBlob,
  GIT_NAMESPACE,
  parseSshPublicKey,
  parseSshSignature,
  type SshSignature,
  SshSignatureError,
  type SshVerification,
  sshCommitSigner,
  sshFingerprint,
  sshSignedData,
  verifySshSignature,
} from "./sign/sshsig.js";
export {
  framedCopyKey,
  type RegeneratedKeyInput,
  regeneratedPackKey,
} from "./upload-pack/cache-key.js";
export { UploadPackError, type UploadPackErrorCode } from "./upload-pack/errors.js";
export {
  DEFAULT_FETCH_PLAN_LIMITS,
  type FetchPlan,
  type FetchPlanLimits,
  type FetchPlanOptions,
  planFetch,
  type UploadPackRepository,
} from "./upload-pack/fetch.js";
export type { MaterialisedPackStore } from "./upload-pack/materialise.js";
export {
  BrokenTagError,
  MAX_TAG_CHAIN,
  type PeeledTip,
  type PeelReader,
  peelRefTips,
} from "./upload-pack/peel.js";
export {
  type FetchResponsePart,
  type RenderOptions,
  renderFetchResponse,
  uploadPackErrorPacket,
} from "./upload-pack/response.js";
export { INFINITE_DEPTH } from "./upload-pack/shallow.js";
export type { VerbatimCandidate } from "./upload-pack/verbatim-plan.js";
export {
  type ArchiveEntry,
  type ArchiveEntryKind,
  deflateRaw,
  gzipMember,
  tarCommitHeader,
  tarEnd,
  tarEntry,
  ZIP_LIMITS,
  type ZipRecord,
  zipEnd,
  zipEntry,
} from "./write/archive.js";
export {
  type BuildCommitInput,
  type BuiltCommit,
  type BuiltObject,
  buildCommit,
  CommitBuildError,
  type CommitBuildErrorCode,
  type FileChange,
  type TreeLookup,
} from "./write/commit-builder.js";
