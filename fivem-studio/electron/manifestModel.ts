export const REDM_MANIFEST_WARNING =
  "I acknowledge that this is a prerelease build of RedM, and I am aware my resources *will* become incompatible once RedM ships.";

export const SUPPORTED_FX_VERSIONS = ["cerulean", "bodacious", "adamant"] as const;
export const SUPPORTED_NODE_VERSIONS = ["16", "22"] as const;
export type ManifestFormValidationIssue =
  | "fx_version"
  | "games"
  | "node_version"
  | "data_files"
  | "ui_page_file"
  | "loadscreen_file"
  | "replace_level_meta_file"
  | "server_only_conflict";

export const MANIFEST_SCALAR_FIELDS = [
  "fx_version",
  "author",
  "description",
  "version",
  "ui_page",
  "loadscreen",
  "replace_level_meta",
  "node_version",
  "this_is_a_map",
  "server_only",
  "loadscreen_manual_shutdown",
  "loadscreen_cursor",
  "use_experimental_fxv2_oal",
  "clr_disable_task_scheduler",
  "rdr3_warning",
] as const;

export const MANIFEST_LIST_FIELDS = [
  "games",
  "shared_scripts",
  "client_scripts",
  "server_scripts",
  "exports",
  "server_exports",
  "files",
  "dependencies",
  "escrow_ignore",
  "provides",
] as const;

export type ManifestScalarField = typeof MANIFEST_SCALAR_FIELDS[number];
export type ManifestListField = typeof MANIFEST_LIST_FIELDS[number];

export interface ManifestDataFile {
  type: string;
  path: string;
}

export function createEmptyManifestDataFile(): ManifestDataFile {
  return { type: "", path: "" };
}

export function manifestDataFileDraftsAreComplete(entries: ManifestDataFile[]): boolean {
  return entries.every((entry) => Boolean(entry.type.trim()) && Boolean(entry.path.trim()));
}

export interface ManifestFormValues {
  fx_version: string;
  author: string;
  description: string;
  version: string;
  ui_page: string;
  loadscreen: string;
  replace_level_meta: string;
  node_version: string;
  this_is_a_map: string;
  server_only: string;
  loadscreen_manual_shutdown: string;
  loadscreen_cursor: string;
  use_experimental_fxv2_oal: string;
  clr_disable_task_scheduler: string;
  rdr3_warning: string;
  games: string[];
  shared_scripts: string[];
  client_scripts: string[];
  server_scripts: string[];
  exports: string[];
  server_exports: string[];
  files: string[];
  dependencies: string[];
  escrow_ignore: string[];
  provides: string[];
  data_files: ManifestDataFile[];
}

export type ManifestParseResult =
  | { ok: true; values: ManifestFormValues }
  | { ok: false; reason: string };

type ManifestField = ManifestScalarField | ManifestListField | "data_files";

interface Statement {
  field: ManifestField;
  start: number;
  end: number;
  indent: string;
  values: string[];
  comments: string[];
}

const FIELD_MAP: Record<string, ManifestField> = {
  fx_version: "fx_version",
  game: "games",
  games: "games",
  author: "author",
  description: "description",
  version: "version",
  shared_script: "shared_scripts",
  shared_scripts: "shared_scripts",
  client_script: "client_scripts",
  client_scripts: "client_scripts",
  server_script: "server_scripts",
  server_scripts: "server_scripts",
  export: "exports",
  exports: "exports",
  server_export: "server_exports",
  server_exports: "server_exports",
  ui_page: "ui_page",
  replace_level_meta: "replace_level_meta",
  data_file: "data_files",
  this_is_a_map: "this_is_a_map",
  server_only: "server_only",
  loadscreen: "loadscreen",
  loadscreen_manual_shutdown: "loadscreen_manual_shutdown",
  loadscreen_cursor: "loadscreen_cursor",
  file: "files",
  files: "files",
  dependency: "dependencies",
  dependencies: "dependencies",
  escrow_ignore: "escrow_ignore",
  node_version: "node_version",
  provide: "provides",
  provides: "provides",
  use_experimental_fxv2_oal: "use_experimental_fxv2_oal",
  clr_disable_task_scheduler: "clr_disable_task_scheduler",
  rdr3_warning: "rdr3_warning",
};

const DIRECTIVE_PATTERN = Object.keys(FIELD_MAP)
  .sort((left, right) => right.length - left.length)
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

function emptyValues(): ManifestFormValues {
  return {
    fx_version: "",
    author: "",
    description: "",
    version: "",
    ui_page: "",
    loadscreen: "",
    replace_level_meta: "",
    node_version: "",
    this_is_a_map: "",
    server_only: "",
    loadscreen_manual_shutdown: "",
    loadscreen_cursor: "",
    use_experimental_fxv2_oal: "",
    clr_disable_task_scheduler: "",
    rdr3_warning: "",
    games: [],
    shared_scripts: [],
    client_scripts: [],
    server_scripts: [],
    exports: [],
    server_exports: [],
    files: [],
    dependencies: [],
    escrow_ignore: [],
    provides: [],
    data_files: [],
  };
}

function parseQuoted(source: string, start: number): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') return null;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\" && index + 1 < source.length) {
      value += source[index + 1];
      index += 1;
    } else if (char === quote) {
      return { value, end: index + 1 };
    } else {
      value += char;
    }
  }
  return null;
}

function skipHorizontalWhitespace(source: string, start: number): number {
  let cursor = start;
  while (source[cursor] === " " || source[cursor] === "\t") cursor += 1;
  return cursor;
}

function lineEnd(source: string, start: number): number {
  const end = source.indexOf("\n", start);
  return end < 0 ? source.length : end + 1;
}

function parseListBody(body: string): string[] | null {
  const values: string[] = [];
  let index = 0;
  while (index < body.length) {
    while (index < body.length && /[\s,]/.test(body[index])) index += 1;
    if (index >= body.length) break;
    if (body[index] === "-" && body[index + 1] === "-") {
      if (longBracketAt(body, index + 2)) return null;
      const nextLine = body.indexOf("\n", index + 2);
      index = nextLine < 0 ? body.length : nextLine + 1;
      continue;
    }
    const parsed = parseQuoted(body, index);
    if (!parsed) return null;
    values.push(parsed.value);
    index = parsed.end;
  }
  return values;
}

interface SourceRange {
  start: number;
  end: number;
  kind: "comment" | "string";
}

function longBracketAt(source: string, start: number): { equals: string; bodyStart: number } | null {
  if (source[start] !== "[") return null;
  let cursor = start + 1;
  while (source[cursor] === "=") cursor += 1;
  return source[cursor] === "[" ? { equals: source.slice(start + 1, cursor), bodyStart: cursor + 1 } : null;
}

/** Ranges where a line-leading directive is only comment/string content. */
function inactiveLuaRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === "-" && source[cursor + 1] === "-") {
      const longComment = longBracketAt(source, cursor + 2);
      if (longComment) {
        const close = `]${longComment.equals}]`;
        const closeAt = source.indexOf(close, longComment.bodyStart);
        const end = closeAt < 0 ? source.length : closeAt + close.length;
        ranges.push({ start: cursor, end, kind: "comment" });
        cursor = end;
        continue;
      }
      const end = source.indexOf("\n", cursor + 2);
      const rangeEnd = end < 0 ? source.length : end + 1;
      ranges.push({ start: cursor, end: rangeEnd, kind: "comment" });
      cursor = rangeEnd;
      continue;
    }

    const quote = source[cursor];
    if (quote === "'" || quote === '"') {
      const start = cursor;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor++] === quote) break;
      }
      ranges.push({ start, end: Math.min(cursor, source.length), kind: "string" });
      continue;
    }

    const longString = longBracketAt(source, cursor);
    if (longString) {
      const start = cursor;
      const close = `]${longString.equals}]`;
      const closeAt = source.indexOf(close, longString.bodyStart);
      const end = closeAt < 0 ? source.length : closeAt + close.length;
      ranges.push({ start, end, kind: "string" });
      cursor = end;
      continue;
    }
    cursor += 1;
  }
  return ranges;
}

function firstRangeStartingAtOrAfter(ranges: SourceRange[], offset: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ranges[middle].start < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function containsOnlyWhitespaceAndComments(source: string, start: number, end: number, ranges: SourceRange[]): boolean {
  let cursor = start;
  let rangeIndex = firstRangeStartingAtOrAfter(ranges, start);
  while (cursor < end) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    while (ranges[rangeIndex]?.start < cursor) rangeIndex += 1;
    const comment = ranges[rangeIndex];
    if (comment?.kind !== "comment" || comment.start !== cursor) return false;
    cursor = Math.min(comment.end, end);
    rangeIndex += 1;
  }
  return true;
}

function commentsStartingInRange(source: string, start: number, end: number, ranges: SourceRange[]): string[] {
  const comments: string[] = [];
  for (let index = firstRangeStartingAtOrAfter(ranges, start); ranges[index]?.start < end; index += 1) {
    const range = ranges[index];
    if (range.kind === "comment") {
      comments.push(source.slice(range.start, Math.min(range.end, end)).replace(/[\r\n]+$/, ""));
    }
  }
  return comments;
}

interface ManifestParserWork {
  inactiveRangeReads: number;
}

function instrumentRangeReads(ranges: SourceRange[], work: ManifestParserWork | undefined): SourceRange[] {
  if (!work) return ranges;
  return new Proxy(ranges, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9]\d*)$/.test(property)) work.inactiveRangeReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
}

function scanStatements(source: string, work?: ManifestParserWork): { statements: Statement[]; error?: string } {
  const statements: Statement[] = [];
  const inactiveRanges = instrumentRangeReads(inactiveLuaRanges(source), work);
  let inactiveIndex = 0;
  const directive = new RegExp(`^([ \\t]*)(${DIRECTIVE_PATTERN})\\b`, "gm");
  for (const match of source.matchAll(directive)) {
    while (inactiveRanges[inactiveIndex] && inactiveRanges[inactiveIndex].end <= match.index!) inactiveIndex += 1;
    const inactive = inactiveRanges[inactiveIndex];
    if (inactive && inactive.start <= match.index! && match.index! < inactive.end) continue;
    const keyword = match[2];
    const field = FIELD_MAP[keyword];
    const start = match.index!;
    let cursor = skipHorizontalWhitespace(source, start + match[0].length);
    let values: string[];
    let contentEnd: number;

    if (field === "data_files") {
      const type = parseQuoted(source, cursor);
      if (!type) return { statements, error: "data_file must contain a quoted type and quoted path." };
      cursor = skipHorizontalWhitespace(source, type.end);
      const filePath = parseQuoted(source, cursor);
      if (!filePath) return { statements, error: "data_file must contain a quoted type and quoted path." };
      values = [type.value, filePath.value];
      contentEnd = filePath.end;
    } else {
      const quotedValue = parseQuoted(source, cursor);
      if (quotedValue) {
        if (MANIFEST_LIST_FIELDS.includes(field as ManifestListField) && keyword.endsWith("s") && keyword !== "escrow_ignore") {
          return { statements, error: `${keyword} must use a brace list or a singular directive for one value.` };
        }
        values = [quotedValue.value];
        contentEnd = quotedValue.end;
      } else if (source[cursor] === "{") {
        if (MANIFEST_SCALAR_FIELDS.includes(field as ManifestScalarField)) {
          return { statements, error: `${keyword} must contain one quoted value.` };
        }
        let quote: string | null = null;
        let close = -1;
        for (let index = cursor + 1; index < source.length; index += 1) {
          const char = source[index];
          if (quote) {
            if (char === "\\") index += 1;
            else if (char === quote) quote = null;
          } else if (char === "'" || char === '"') {
            quote = char;
          } else if (char === "-" && source[index + 1] === "-") {
            const nextLine = source.indexOf("\n", index + 2);
            index = nextLine < 0 ? source.length : nextLine;
          } else if (char === "}") {
            close = index;
            break;
          }
        }
        if (close < 0) return { statements, error: `${keyword} has an unterminated brace list.` };
        const parsed = parseListBody(source.slice(cursor + 1, close));
        if (!parsed) return { statements, error: `${keyword} contains a dynamic value the form cannot preserve safely.` };
        values = parsed;
        contentEnd = close + 1;
      } else {
        return { statements, error: `${keyword} contains a dynamic value the form cannot preserve safely.` };
      }
    }

    let end = lineEnd(source, contentEnd);
    let trailingMultilineComment: SourceRange | undefined;
    for (let index = firstRangeStartingAtOrAfter(inactiveRanges, contentEnd); inactiveRanges[index]?.start < end; index += 1) {
      const range = inactiveRanges[index];
      if (range.kind === "comment" && range.end > end) {
        trailingMultilineComment = range;
        break;
      }
    }
    if (trailingMultilineComment) end = lineEnd(source, trailingMultilineComment.end);
    if (!containsOnlyWhitespaceAndComments(source, contentEnd, end, inactiveRanges)) {
      return { statements, error: `${keyword} contains extra Lua syntax the form cannot preserve safely.` };
    }
    statements.push({
      field,
      start,
      end,
      indent: match[1],
      values,
      comments: commentsStartingInRange(source, start, end, inactiveRanges),
    });
  }
  return { statements };
}

/** Deterministic parser-complexity instrumentation used by adversarial tests. */
export function manifestParserRangeReadsForTesting(source: string): { inactiveRangeReads: number; statementCount: number } {
  const work: ManifestParserWork = { inactiveRangeReads: 0 };
  const scanned = scanStatements(source, work);
  if (scanned.error) throw new Error(scanned.error);
  return { inactiveRangeReads: work.inactiveRangeReads, statementCount: scanned.statements.length };
}

function validateGames(games: string[]): string | null {
  const normalized = games.map((game) => game.toLowerCase());
  if (normalized.some((game) => !["common", "gta5", "rdr3"].includes(game))) {
    return "game supports only common, gta5, or rdr3 in the current Cfx manifest format.";
  }
  if (normalized.includes("common") && normalized.some((game) => game !== "common")) {
    return "game common cannot be combined with gta5 or rdr3.";
  }
  return null;
}

function normalizedPackfilePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

type PackfileGlobToken =
  | { kind: "literal"; value: string }
  | { kind: "single" | "segment-star" | "glob-star" | "glob-star-slash" };

const MAX_PACKFILE_GLOB_WORK = 4_000_000;
const MAX_PACKFILE_GLOB_LENGTH = 4_096;
const MAX_PACKFILE_GLOB_PATTERNS = 4_096;

function packfileGlobTokens(pattern: string): PackfileGlobToken[] {
  const tokens: PackfileGlobToken[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        tokens.push({ kind: "glob-star-slash" });
      } else {
        tokens.push({ kind: "glob-star" });
      }
    } else if (char === "*") {
      tokens.push({ kind: "segment-star" });
    } else if (char === "?") {
      tokens.push({ kind: "single" });
    } else {
      tokens.push({ kind: "literal", value: char });
    }
  }
  return tokens;
}

/** Thompson-style wildcard evaluation with predictable O(pattern × target) work. */
function globMatchesPath(tokens: PackfileGlobToken[], target: string): boolean {
  let previous = new Uint8Array(target.length + 1);
  let current = new Uint8Array(target.length + 1);
  previous[0] = 1;

  for (const token of tokens) {
    current.fill(0);
    if (token.kind === "literal" || token.kind === "single") {
      for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
        const char = target[targetIndex - 1];
        if (previous[targetIndex - 1] && (token.kind === "literal" ? char === token.value : char !== "/")) {
          current[targetIndex] = 1;
        }
      }
    } else if (token.kind === "segment-star" || token.kind === "glob-star") {
      current[0] = previous[0];
      for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
        const starCanConsume = token.kind === "glob-star" || target[targetIndex - 1] !== "/";
        if (previous[targetIndex] || (starCanConsume && current[targetIndex - 1])) current[targetIndex] = 1;
      }
    } else {
      // **/ is either empty or any prefix ending in a slash. A running prefix
      // reachability bit avoids the unbounded `(?:.*/)?` regex backtracking.
      current[0] = previous[0];
      let previousPrefixReachable = previous[0] === 1;
      for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
        if (previous[targetIndex] || (target[targetIndex - 1] === "/" && previousPrefixReachable)) {
          current[targetIndex] = 1;
        }
        previousPrefixReachable ||= previous[targetIndex] === 1;
      }
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[target.length] === 1;
}

export function manifestPackfileCovers(files: string[], target: string): boolean {
  const normalizedTarget = normalizedPackfilePath(target).split(/[?#]/, 1)[0];
  if (!normalizedTarget) return false;

  const wildcardPatterns: string[] = [];
  for (const patternValue of files) {
    const pattern = normalizedPackfilePath(patternValue);
    if (!pattern) continue;
    if (!/[*?]/.test(pattern)) {
      if (pattern === normalizedTarget) return true;
    } else if (wildcardPatterns.length < MAX_PACKFILE_GLOB_PATTERNS && pattern.length <= MAX_PACKFILE_GLOB_LENGTH) {
      wildcardPatterns.push(pattern);
    }
  }

  if (normalizedTarget.length > MAX_PACKFILE_GLOB_LENGTH) return false;
  wildcardPatterns.sort((left, right) => left.length - right.length);
  let remainingWork = MAX_PACKFILE_GLOB_WORK;
  for (const pattern of wildcardPatterns) {
    const tokens = packfileGlobTokens(pattern);
    const work = tokens.length * (normalizedTarget.length + 1);
    if (!Number.isSafeInteger(work) || work > remainingWork) continue;
    remainingWork -= work;
    if (globMatchesPath(tokens, normalizedTarget)) return true;
  }
  return false;
}

function localPageNeedsPackfile(value: string): boolean {
  const page = value.trim();
  return Boolean(page) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(page) && !page.startsWith("//");
}

export function normalizeManifestListDraft(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function manifestPresenceFlagIsActive(value: string): boolean {
  return value.trim().length > 0;
}

function serverOnlyHasClientContent(values: ManifestFormValues): boolean {
  return values.shared_scripts.length > 0 ||
    values.client_scripts.length > 0 ||
    values.exports.length > 0 ||
    values.files.length > 0 ||
    values.data_files.length > 0 ||
    manifestPresenceFlagIsActive(values.ui_page) ||
    manifestPresenceFlagIsActive(values.loadscreen) ||
    manifestPresenceFlagIsActive(values.replace_level_meta) ||
    manifestPresenceFlagIsActive(values.this_is_a_map) ||
    manifestPresenceFlagIsActive(values.loadscreen_manual_shutdown) ||
    manifestPresenceFlagIsActive(values.loadscreen_cursor);
}

function replaceLevelMetaPackfilePath(value: string): string {
  const replacement = value.trim();
  return replacement.toLowerCase().endsWith(".meta") ? replacement : `${replacement}.meta`;
}

export function validateManifestFormValues(values: ManifestFormValues): ManifestFormValidationIssue[] {
  const issues: ManifestFormValidationIssue[] = [];
  if (!SUPPORTED_FX_VERSIONS.includes(values.fx_version as typeof SUPPORTED_FX_VERSIONS[number])) {
    issues.push("fx_version");
  }
  if (values.games.length === 0 || validateGames(values.games)) issues.push("games");
  if (values.node_version.trim() && !SUPPORTED_NODE_VERSIONS.includes(
    values.node_version.trim() as typeof SUPPORTED_NODE_VERSIONS[number],
  )) {
    issues.push("node_version");
  }
  if (!manifestDataFileDraftsAreComplete(values.data_files)) issues.push("data_files");
  if (localPageNeedsPackfile(values.ui_page) && !manifestPackfileCovers(values.files, values.ui_page)) {
    issues.push("ui_page_file");
  }
  if (localPageNeedsPackfile(values.loadscreen) && !manifestPackfileCovers(values.files, values.loadscreen)) {
    issues.push("loadscreen_file");
  }
  if (values.replace_level_meta.trim() && !manifestPackfileCovers(
    values.files,
    replaceLevelMetaPackfilePath(values.replace_level_meta),
  )) {
    issues.push("replace_level_meta_file");
  }
  if (manifestPresenceFlagIsActive(values.server_only) && serverOnlyHasClientContent(values)) {
    issues.push("server_only_conflict");
  }
  return issues;
}

export function parseManifestForm(source: string): ManifestParseResult {
  const scanned = scanStatements(source);
  if (scanned.error) return { ok: false, reason: scanned.error };
  const values = emptyValues();
  for (const statement of scanned.statements) {
    if (MANIFEST_SCALAR_FIELDS.includes(statement.field as ManifestScalarField)) {
      const field = statement.field as ManifestScalarField;
      if (values[field]) return { ok: false, reason: `${field} appears more than once.` };
      values[field] = statement.values[0] ?? "";
    } else if (statement.field === "data_files") {
      values.data_files.push({ type: statement.values[0] ?? "", path: statement.values[1] ?? "" });
    } else {
      values[statement.field as ManifestListField].push(...statement.values);
    }
  }
  const gameError = validateGames(values.games);
  return gameError ? { ok: false, reason: gameError } : { ok: true, values };
}

function sameValues(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function sameDataFiles(first: ManifestDataFile[], second: ManifestDataFile[]): boolean {
  return first.length === second.length && first.every((value, index) =>
    value.type === second[index]?.type && value.path === second[index]?.path,
  );
}

function quoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function renderList(field: ManifestListField, values: string[], indent: string, lineEnding: string): string {
  if (values.length === 0) return "";
  if (field === "provides") {
    return values.map((value) => `${indent}provide ${quoted(value)}${lineEnding}`).join("");
  }
  return `${indent}${field} {${lineEnding}` +
    values.map((value) => `${indent}  ${quoted(value)},`).join(lineEnding) +
    `${lineEnding}${indent}}${lineEnding}`;
}

function normalizedValues(next: ManifestFormValues): ManifestFormValues {
  const games = next.games.map((game) => game.trim()).filter(Boolean);
  const gameError = validateGames(games);
  if (gameError) throw new Error(gameError);
  return {
    ...next,
    games,
    rdr3_warning: games.some((game) => game.toLowerCase() === "rdr3") ? REDM_MANIFEST_WARNING : "",
  };
}

export function updateManifestForm(source: string, requested: ManifestFormValues): string {
  const parsed = parseManifestForm(source);
  if (!parsed.ok) throw new Error(parsed.reason);
  const scanned = scanStatements(source);
  if (scanned.error) throw new Error(scanned.error);
  const next = normalizedValues(requested);
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const patches: Array<{ start: number; end: number; text: string }> = [];
  let appendText = "";

  function replaceField(field: ManifestField, statementText: string): void {
    const existing = scanned.statements.filter((statement) => statement.field === field);
    const comments = existing.flatMap((statement) => statement.comments);
    const indent = existing[0]?.indent ?? "";
    const commentText = comments.map((comment) => `${indent}${comment}${lineEnding}`).join("");
    const replacement = commentText + statementText;
    if (existing.length > 0) {
      patches.push({ start: existing[0].start, end: existing[0].end, text: replacement });
      for (const extra of existing.slice(1)) patches.push({ start: extra.start, end: extra.end, text: "" });
    } else if (replacement) {
      appendText += replacement;
    }
  }

  for (const field of MANIFEST_SCALAR_FIELDS) {
    const previous = parsed.values[field];
    const desired = next[field].trim();
    if (previous === desired) continue;
    const indent = scanned.statements.find((statement) => statement.field === field)?.indent ?? "";
    replaceField(field, desired ? `${indent}${field} ${quoted(desired)}${lineEnding}` : "");
  }

  for (const field of MANIFEST_LIST_FIELDS) {
    const desired = next[field].map((value) => value.trim()).filter(Boolean);
    if (sameValues(parsed.values[field], desired)) continue;
    const indent = scanned.statements.find((statement) => statement.field === field)?.indent ?? "";
    replaceField(field, renderList(field, desired, indent, lineEnding));
  }

  const desiredDataFiles = next.data_files
    .map((entry) => ({ type: entry.type.trim(), path: entry.path.trim() }))
    .filter((entry) => entry.type || entry.path);
  if (!sameDataFiles(parsed.values.data_files, desiredDataFiles)) {
    const indent = scanned.statements.find((statement) => statement.field === "data_files")?.indent ?? "";
    replaceField("data_files", desiredDataFiles.map((entry) =>
      `${indent}data_file ${quoted(entry.type)} ${quoted(entry.path)}${lineEnding}`,
    ).join(""));
  }

  if (appendText) {
    const prefix = source.length > 0 && !source.endsWith("\n") ? lineEnding : "";
    patches.push({ start: source.length, end: source.length, text: `${prefix}${appendText}` });
  }
  return patches.sort((left, right) => right.start - left.start).reduce(
    (content, patch) => content.slice(0, patch.start) + patch.text + content.slice(patch.end),
    source,
  );
}
