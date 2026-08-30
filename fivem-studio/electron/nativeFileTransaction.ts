import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type NativeFileData = string | Uint8Array;

export interface NativeFileWriteOptions {
  /** Final POSIX permission bits. Defaults to owner read/write only. */
  mode?: number;
}

export interface NativeFileOperations {
  makeDirectory(directory: string): void;
  lstat(filePath: string): Pick<fs.Stats, "mode" | "size" | "isFile">;
  readFile(filePath: string): Buffer;
  openExclusive(filePath: string, mode: number): number;
  openExisting(filePath: string): number;
  truncate(descriptor: number): void;
  writeAll(descriptor: number, data: Uint8Array): void;
  setMode(descriptor: number, mode: number): void;
  sync(descriptor: number): void;
  close(descriptor: number): void;
  replaceFile(source: string, target: string): void;
  removeFile(filePath: string): void;
  syncDirectory(directory: string): void;
}

export interface NativeFileRollbackFailure {
  path: string;
  operation: "restore" | "remove";
  error: Error;
}

export class NativeFileTransactionError extends Error {
  readonly rollbackFailures: readonly NativeFileRollbackFailure[];

  constructor(cause: unknown, rollbackFailures: readonly NativeFileRollbackFailure[]) {
    const original = errorMessage(cause);
    const rollbackSummary = rollbackFailures.length === 0
      ? ""
      : ` Rollback also failed for ${rollbackFailures.map((failure) =>
          `${failure.operation} ${failure.path}: ${failure.error.message}`).join("; ")}.`;
    super(`File transaction failed: ${original}.${rollbackSummary}`, { cause });
    this.name = "NativeFileTransactionError";
    this.rollbackFailures = Object.freeze([...rollbackFailures]);
  }
}

type NativeFileMutation =
  | { kind: "write"; path: string; data: Buffer; mode: number }
  | { kind: "remove"; path: string };

type NativeFileSnapshot =
  | { path: string; existed: false }
  | { path: string; existed: true; data: Buffer; mode: number };

interface ReplayJournalBody {
  version: 1;
  state: "pending" | "redo";
  publicFile: { data: string; mode: number };
  mutations: Array<
    | { kind: "write"; path: string; data: string; mode: number }
    | { kind: "remove"; path: string }
  >;
}

interface AbortedJournalBody {
  version: 1;
  state: "aborted";
}

type JournalBody = ReplayJournalBody | AbortedJournalBody;

export interface NativeFileRecoveryOptions {
  /** Recovery journals are untrusted; limit paths to this public file's credential namespace. */
  isPrivatePathAllowed(filePath: string): boolean;
  operations?: Partial<NativeFileOperations>;
}

export type NativeFileRecoveryResult = "none" | "recovered" | "discarded";

const DEFAULT_MODE = 0o600;
const JOURNAL_MODE = 0o600;
const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_BYTES = 2 * 1024 * 1024;
const MAX_PRIVATE_WRITE_BYTES = 128 * 1024;
const MAX_MUTATIONS = 512;
const MAX_PATH_LENGTH = 32_767;

const NODE_FILE_OPERATIONS: NativeFileOperations = {
  makeDirectory(directory) { fs.mkdirSync(directory, { recursive: true }); },
  lstat(filePath) { return fs.lstatSync(filePath); },
  readFile(filePath) { return fs.readFileSync(filePath); },
  openExclusive(filePath, mode) { return fs.openSync(filePath, "wx", mode); },
  openExisting(filePath) { return fs.openSync(filePath, "r+"); },
  truncate(descriptor) { fs.ftruncateSync(descriptor, 0); },
  writeAll(descriptor, data) { fs.writeFileSync(descriptor, data); },
  setMode(descriptor, mode) { fs.fchmodSync(descriptor, mode); },
  sync(descriptor) { fs.fsyncSync(descriptor); },
  close(descriptor) { fs.closeSync(descriptor); },
  replaceFile(source, target) { fs.renameSync(source, target); },
  removeFile(filePath) { fs.unlinkSync(filePath); },
  syncDirectory(directory) {
    // Windows fsyncs the file with FlushFileBuffers but rejects directory
    // handles. POSIX also needs the directory entry fsynced after rename/unlink.
    if (process.platform === "win32") return;
    const descriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function validatedMode(mode: number | undefined): number {
  const resolved = mode ?? DEFAULT_MODE;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 0o777) {
    throw new Error("File mode must be an integer between 0o000 and 0o777.");
  }
  return resolved;
}

function resolvedFilePath(filePath: string): string {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > MAX_PATH_LENGTH || filePath.includes("\0")) {
    throw new Error(`File transaction paths must be non-empty strings up to ${MAX_PATH_LENGTH} characters without null bytes.`);
  }
  return path.resolve(filePath);
}

function pathIdentity(filePath: string): string {
  return process.platform === "win32" ? filePath.toLocaleLowerCase() : filePath;
}

function ownedBuffer(data: NativeFileData): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

function aggregateFailure(primary: unknown, secondary: unknown, message: string): AggregateError {
  return new AggregateError([primary, secondary], message);
}

class AtomicFileWriteError extends Error {
  readonly replacementCompleted: boolean;

  constructor(cause: unknown, replacementCompleted: boolean) {
    super(errorMessage(cause), { cause });
    this.name = "AtomicFileWriteError";
    this.replacementCompleted = replacementCompleted;
  }
}

function removeFileStrict(operations: NativeFileOperations, filePath: string): boolean {
  try {
    operations.removeFile(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function removeFileDurably(operations: NativeFileOperations, filePath: string): void {
  if (removeFileStrict(operations, filePath)) operations.syncDirectory(path.dirname(filePath));
}

/** Write through a fsynced exclusive temporary and durably replace the target. */
function writeFileAtomically(
  operations: NativeFileOperations,
  target: string,
  data: Uint8Array,
  mode: number,
): void {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  operations.makeDirectory(directory);
  let descriptor: number | null = null;
  let temporaryExists = false;
  let replacementCompleted = false;
  try {
    descriptor = operations.openExclusive(temporary, mode);
    temporaryExists = true;
    operations.writeAll(descriptor, data);
    operations.setMode(descriptor, mode);
    operations.sync(descriptor);
    const descriptorToClose = descriptor;
    descriptor = null;
    operations.close(descriptorToClose);
    operations.replaceFile(temporary, target);
    temporaryExists = false;
    replacementCompleted = true;
    operations.syncDirectory(directory);
  } catch (error) {
    let failure: unknown = error;
    if (descriptor !== null) {
      const descriptorToClose = descriptor;
      descriptor = null;
      try { operations.close(descriptorToClose); } catch (closeError) {
        failure = aggregateFailure(failure, closeError, "Atomic file write failed and closing its temporary file also failed.");
      }
    }
    if (temporaryExists) {
      try { removeFileStrict(operations, temporary); } catch (cleanupError) {
        failure = aggregateFailure(failure, cleanupError, "Atomic file write failed and temporary-file cleanup also failed.");
      }
    }
    throw new AtomicFileWriteError(failure, replacementCompleted);
  }
}

/** Rewrite an already-durable journal inode without changing its directory entry. */
function rewriteFileInPlace(
  operations: NativeFileOperations,
  target: string,
  data: Uint8Array,
  mode: number,
): void {
  let descriptor: number | null = null;
  try {
    descriptor = operations.openExisting(target);
    operations.truncate(descriptor);
    operations.writeAll(descriptor, data);
    operations.setMode(descriptor, mode);
    operations.sync(descriptor);
    const descriptorToClose = descriptor;
    descriptor = null;
    operations.close(descriptorToClose);
  } catch (error) {
    let failure: unknown = error;
    if (descriptor !== null) {
      try { operations.close(descriptor); } catch (closeError) {
        failure = aggregateFailure(failure, closeError, "Journal rewrite failed and closing it also failed.");
      }
    }
    throw failure;
  }
}

function snapshotFile(operations: NativeFileOperations, filePath: string): NativeFileSnapshot {
  let metadata: Pick<fs.Stats, "mode" | "size" | "isFile">;
  try { metadata = operations.lstat(filePath); } catch (error) {
    if (isMissingFile(error)) return { path: filePath, existed: false };
    throw error;
  }
  if (!metadata.isFile()) throw new Error(`Transaction target is not a regular file: ${filePath}`);
  return {
    path: filePath,
    existed: true,
    data: Buffer.from(operations.readFile(filePath)),
    mode: metadata.mode & 0o777,
  };
}

function rollbackCredentials(
  operations: NativeFileOperations,
  snapshots: readonly NativeFileSnapshot[],
): NativeFileRollbackFailure[] {
  const failures: NativeFileRollbackFailure[] = [];
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    try {
      if (snapshot.existed) writeFileAtomically(operations, snapshot.path, snapshot.data, snapshot.mode);
      else removeFileDurably(operations, snapshot.path);
    } catch (error) {
      failures.push({
        path: snapshot.path,
        operation: snapshot.existed ? "restore" : "remove",
        error: asError(error),
      });
    }
  }
  return failures;
}

function checksumFor(body: JournalBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function serializeJournal(body: JournalBody): Buffer {
  const serialized = Buffer.from(JSON.stringify({ ...body, checksum: checksumFor(body) }), "utf8");
  if (serialized.length > MAX_JOURNAL_BYTES) throw new Error(`File transaction journal exceeds ${MAX_JOURNAL_BYTES} bytes.`);
  return serialized;
}

function createReplayJournal(
  mutations: readonly NativeFileMutation[],
  publicData: Buffer,
  publicMode: number,
  state: ReplayJournalBody["state"],
): Buffer {
  if (mutations.length > MAX_MUTATIONS) throw new Error(`A file transaction can contain no more than ${MAX_MUTATIONS} private mutations.`);
  if (publicData.length > MAX_PUBLIC_BYTES) throw new Error(`The public file exceeds the ${MAX_PUBLIC_BYTES}-byte recovery limit.`);
  const journalMutations: ReplayJournalBody["mutations"] = mutations.map((mutation) => {
    if (mutation.kind === "remove") return { kind: "remove", path: mutation.path };
    if (mutation.data.length > MAX_PRIVATE_WRITE_BYTES) {
      throw new Error(`A private file exceeds the ${MAX_PRIVATE_WRITE_BYTES}-byte recovery limit: ${mutation.path}`);
    }
    return { kind: "write", path: mutation.path, data: mutation.data.toString("base64"), mode: mutation.mode };
  });
  return serializeJournal({
    version: JOURNAL_VERSION,
    state,
    publicFile: { data: publicData.toString("base64"), mode: publicMode },
    mutations: journalMutations,
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBoundedBase64(value: unknown, maximumBytes: number, label: string): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximumBytes / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not valid bounded base64 data.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maximumBytes || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not valid bounded base64 data.`);
  }
  return decoded;
}

function validatedJournalPath(value: unknown): string {
  if (typeof value !== "string") throw new Error("A recovery path is invalid.");
  const resolved = resolvedFilePath(value);
  if (!path.isAbsolute(value) || pathIdentity(resolved) !== pathIdentity(value)) {
    throw new Error("Recovery paths must be normalized absolute paths.");
  }
  return resolved;
}

function parseJournal(raw: Buffer, isPrivatePathAllowed: (filePath: string) => boolean):
    | { state: "aborted" }
    | { state: "pending" }
    | { state: "redo"; publicData: Buffer; publicMode: number; mutations: NativeFileMutation[] } {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch { throw new Error("The recovery journal is not valid JSON."); }
  if (!isRecord(value) || value.version !== JOURNAL_VERSION ||
      (value.state !== "pending" && value.state !== "redo" && value.state !== "aborted") ||
      typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/.test(value.checksum)) {
    throw new Error("The recovery journal header is invalid.");
  }
  if (value.state === "aborted") {
    if (!hasExactKeys(value, ["version", "state", "checksum"])) throw new Error("The aborted recovery journal has unexpected fields.");
    const body: AbortedJournalBody = { version: JOURNAL_VERSION, state: "aborted" };
    if (checksumFor(body) !== value.checksum) throw new Error("The recovery journal checksum is invalid.");
    return { state: "aborted" };
  }
  if (!hasExactKeys(value, ["version", "state", "publicFile", "mutations", "checksum"]) ||
      !isRecord(value.publicFile) || !hasExactKeys(value.publicFile, ["data", "mode"]) ||
      !Array.isArray(value.mutations) || value.mutations.length > MAX_MUTATIONS) {
    throw new Error("The redo recovery journal structure is invalid.");
  }
  const replayState = value.state;
  const body: ReplayJournalBody = {
    version: JOURNAL_VERSION,
    state: replayState,
    publicFile: value.publicFile as unknown as ReplayJournalBody["publicFile"],
    mutations: value.mutations as ReplayJournalBody["mutations"],
  };
  if (checksumFor(body) !== value.checksum) throw new Error("The recovery journal checksum is invalid.");
  const publicMode = validatedMode(value.publicFile.mode as number | undefined);
  const publicData = decodeBoundedBase64(value.publicFile.data, MAX_PUBLIC_BYTES, "The public recovery file");
  const targets = new Set<string>();
  const mutations: NativeFileMutation[] = value.mutations.map((candidate, index) => {
    if (!isRecord(candidate) || (candidate.kind !== "write" && candidate.kind !== "remove")) {
      throw new Error(`Recovery mutation ${index} is invalid.`);
    }
    const expectedKeys = candidate.kind === "write" ? ["kind", "path", "data", "mode"] : ["kind", "path"];
    if (!hasExactKeys(candidate, expectedKeys)) throw new Error(`Recovery mutation ${index} has unexpected fields.`);
    const target = validatedJournalPath(candidate.path);
    const identity = pathIdentity(target);
    if (targets.has(identity)) throw new Error("The recovery journal contains a duplicate private path.");
    targets.add(identity);
    let allowed = false;
    try { allowed = isPrivatePathAllowed(target); } catch { allowed = false; }
    if (!allowed) throw new Error(`The recovery journal contains a private path outside its allowed namespace: ${target}`);
    if (candidate.kind === "remove") return { kind: "remove", path: target };
    return {
      kind: "write",
      path: target,
      data: decodeBoundedBase64(candidate.data, MAX_PRIVATE_WRITE_BYTES, `Recovery mutation ${index}`),
      mode: validatedMode(candidate.mode as number | undefined),
    };
  });
  return replayState === "pending"
    ? { state: "pending" }
    : { state: "redo", publicData, publicMode, mutations };
}

function journalExists(operations: NativeFileOperations, journalPath: string): boolean {
  try {
    const metadata = operations.lstat(journalPath);
    if (!metadata.isFile()) throw new Error(`File transaction journal is not a regular file: ${journalPath}`);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

export function nativeFileTransactionJournalPath(publicFilePath: string): string {
  const target = resolvedFilePath(publicFilePath);
  return path.join(path.dirname(target), `.${path.basename(target)}.native-transaction.json`);
}

/** Validate the complete untrusted journal, then replay it before the public file is loaded. */
export function recoverNativeFileTransaction(
  publicFilePath: string,
  options: NativeFileRecoveryOptions,
): NativeFileRecoveryResult {
  const publicTarget = resolvedFilePath(publicFilePath);
  const journalPath = nativeFileTransactionJournalPath(publicTarget);
  const operations = { ...NODE_FILE_OPERATIONS, ...(options.operations ?? {}) };
  if (typeof options.isPrivatePathAllowed !== "function") throw new Error("Native file recovery requires a private-path validator.");
  let metadata: Pick<fs.Stats, "mode" | "size" | "isFile">;
  try { metadata = operations.lstat(journalPath); } catch (error) {
    if (isMissingFile(error)) return "none";
    throw new Error(`File transaction recovery could not inspect its journal: ${errorMessage(error)}`, { cause: error });
  }
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_JOURNAL_BYTES) {
    throw new Error("File transaction recovery refused an invalid journal file.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("File transaction recovery refused a journal that is not owner-only.");
  }
  let parsed: ReturnType<typeof parseJournal>;
  try {
    const raw = operations.readFile(journalPath);
    if (raw.length !== metadata.size || raw.length > MAX_JOURNAL_BYTES) throw new Error("The recovery journal changed while it was being read.");
    parsed = parseJournal(raw, options.isPrivatePathAllowed);
    if (parsed.state === "redo" && parsed.mutations.some((mutation) =>
      pathIdentity(mutation.path) === pathIdentity(publicTarget))) {
      throw new Error("The public recovery file is also listed as a private mutation.");
    }
  } catch (error) {
    throw new Error(`File transaction recovery refused its journal: ${errorMessage(error)}`, { cause: error });
  }
  try {
    if (parsed.state === "aborted" || parsed.state === "pending") {
      removeFileDurably(operations, journalPath);
      return "discarded";
    }
    for (const mutation of parsed.mutations) {
      if (mutation.kind === "write") writeFileAtomically(operations, mutation.path, mutation.data, mutation.mode);
      else removeFileDurably(operations, mutation.path);
    }
    writeFileAtomically(operations, publicTarget, parsed.publicData, parsed.publicMode);
    removeFileDurably(operations, journalPath);
    return "recovered";
  } catch (error) {
    throw new Error(`File transaction recovery could not finish safely: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Transaction for already-encrypted private bytes followed by one public-file
 * commit. Callers must never stage plaintext credentials: write bytes are
 * copied verbatim into the owner-only durable redo journal.
 */
export class NativeFileTransaction {
  private readonly operations: NativeFileOperations;
  private readonly mutations: NativeFileMutation[] = [];
  private readonly targets = new Set<string>();
  private finished = false;

  constructor(operations: Partial<NativeFileOperations> = {}) {
    this.operations = { ...NODE_FILE_OPERATIONS, ...operations };
  }

  stageWrite(filePath: string, data: NativeFileData, options: NativeFileWriteOptions = {}): this {
    this.requireOpen();
    const target = resolvedFilePath(filePath);
    this.claimTarget(target);
    this.mutations.push({ kind: "write", path: target, data: ownedBuffer(data), mode: validatedMode(options.mode) });
    return this;
  }

  stageRemoval(filePath: string): this {
    this.requireOpen();
    const target = resolvedFilePath(filePath);
    this.claimTarget(target);
    this.mutations.push({ kind: "remove", path: target });
    return this;
  }

  /** Journal, apply every private mutation, then durably replace the public file last. */
  commit(publicFilePath: string, data: NativeFileData, options: NativeFileWriteOptions = {}): void {
    this.requireOpen();
    this.finished = true;
    const publicTarget = resolvedFilePath(publicFilePath);
    if (this.targets.has(pathIdentity(publicTarget))) throw new Error("The final public file cannot also be a staged private-file target.");
    const publicData = ownedBuffer(data);
    const publicMode = validatedMode(options.mode);
    const journalPath = nativeFileTransactionJournalPath(publicTarget);
    let snapshots: NativeFileSnapshot[];
    try {
      snapshots = this.mutations.map((mutation) => snapshotFile(this.operations, mutation.path));
      const pendingJournal = createReplayJournal(this.mutations, publicData, publicMode, "pending");
      const redoJournal = createReplayJournal(this.mutations, publicData, publicMode, "redo");
      if (journalExists(this.operations, journalPath)) throw new Error("An earlier file transaction still requires startup recovery.");
      try {
        // A landed-but-not-directory-fsynced first phase is deliberately not
        // armed: recovery discards `pending` without applying its save.
        writeFileAtomically(this.operations, journalPath, pendingJournal, JOURNAL_MODE);
      } catch (error) {
        if (error instanceof AtomicFileWriteError && error.replacementCompleted) {
          try { removeFileDurably(this.operations, journalPath); } catch { /* pending remains safe to discard at startup */ }
        }
        throw error;
      }
      // The directory entry is now durable. Rewriting the same inode and
      // fsyncing it arms redo without another rename/directory durability gap.
      rewriteFileInPlace(this.operations, journalPath, redoJournal, JOURNAL_MODE);
    } catch (error) {
      throw new NativeFileTransactionError(error, []);
    }
    let writingPublicFile = false;
    try {
      for (const mutation of this.mutations) {
        if (mutation.kind === "write") writeFileAtomically(this.operations, mutation.path, mutation.data, mutation.mode);
        else removeFileDurably(this.operations, mutation.path);
      }
      writingPublicFile = true;
      writeFileAtomically(this.operations, publicTarget, publicData, publicMode);
    } catch (error) {
      // Once the public rename has landed, rolling private files back could make
      // that new config refer to retired keys. Retain the redo journal instead;
      // startup will repeat the already-idempotent writes and fsyncs.
      if (writingPublicFile && error instanceof AtomicFileWriteError && error.replacementCompleted) {
        throw new NativeFileTransactionError(error, []);
      }
      const rollbackFailures = rollbackCredentials(this.operations, snapshots);
      if (rollbackFailures.length === 0) {
        try {
          writeFileAtomically(
            this.operations,
            journalPath,
            serializeJournal({ version: JOURNAL_VERSION, state: "aborted" }),
            JOURNAL_MODE,
          );
          try { removeFileDurably(this.operations, journalPath); } catch { /* retry harmlessly at startup */ }
        } catch { /* keep redo journal; startup will establish the consistent new state */ }
      }
      throw new NativeFileTransactionError(error, rollbackFailures);
    }
    // A failed unlink only leaves an idempotent redo journal for next startup.
    try { removeFileDurably(this.operations, journalPath); } catch { /* recovered on next launch */ }
  }

  private requireOpen(): void {
    if (this.finished) throw new Error("A native file transaction can be committed only once.");
  }

  private claimTarget(filePath: string): void {
    const identity = pathIdentity(filePath);
    if (this.targets.has(identity)) throw new Error(`A file can be staged only once per transaction: ${filePath}`);
    this.targets.add(identity);
  }
}
