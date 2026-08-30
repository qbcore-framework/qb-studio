export type ConsoleSourceKind = "resource" | "relative" | "profile" | "absolute";

export interface ConsoleSourceLocationRequest {
  kind: ConsoleSourceKind;
  source: string;
  resourceName?: string;
  line: number;
  column: number;
}

export interface ConsoleSourceMatch extends ConsoleSourceLocationRequest {
  start: number;
  end: number;
}

const MAX_PARSED_LINE_LENGTH = 65_536;
const MAX_SOURCE_LENGTH = 2_048;
const MAX_LINE = 10_000_000;
const MAX_COLUMN = 1_000_000;
const RESOURCE_NAME = "[A-Za-z0-9_.-]{1,128}";
const SOURCE_EXTENSION = "(?:lua|js|mjs|cjs|ts|tsx|jsx|cs|cfg|json|sql|xml|html|css|scss|sass|vue|svelte)";
const RESOURCE_FILE = `([^\\r\\n:<>\"|?*\\u0000-\\u001f]*?\\.${SOURCE_EXTENSION})`;
const WINDOWS_PATH_CHARACTER = `[^\\r\\n:<>\"|?*\\u0000-\\u001f]`;
const UNC_COMPONENT = `[^\\r\\n:\\\\/<>\"|?*\\u0000-\\u001f]+`;
const WINDOWS_ROOT = `(?:[A-Za-z]:[\\\\/]|(?:\\\\\\\\|//)${UNC_COMPONENT}[\\\\/]${UNC_COMPONENT}[\\\\/])`;
const WINDOWS_FILE = `(${WINDOWS_ROOT}${WINDOWS_PATH_CHARACTER}*?\\.${SOURCE_EXTENSION})`;
const RELATIVE_FILE = `((?:(?:\\.\\.?|[A-Za-z0-9_@+\\-\\[\\]]+)[\\\\/])*[A-Za-z0-9_@+.-]+\\.${SOURCE_EXTENSION})`;
const RELATIVE_COMPONENT_WITH_SPACES = `[A-Za-z0-9_@+\\-\\[\\]](?:[A-Za-z0-9_@+ .\\-\\[\\]]*[A-Za-z0-9_@+.\\-\\[\\]])?`;
const RELATIVE_FILE_WITH_SPACES = `((?:(?:\\.\\.?|${RELATIVE_COMPONENT_WITH_SPACES})[\\\\/])+${RELATIVE_COMPONENT_WITH_SPACES}\\.${SOURCE_EXTENSION})`;
const LOCATION_END = "(?=$|[\\s),\\]}:;'\"])";

const LOAD_SCRIPT = /\bError loading script\s+(.+?)\s+in resource\s+([A-Za-z0-9_.-]{1,128})\s+at line\s+([0-9]{1,9})\s*,\s*column\s+([0-9]{1,9})/gi;

interface PatternDefinition {
  expression: RegExp;
  kind: ConsoleSourceKind;
  labelGroup: number;
  sourceGroup: number;
  lineGroup: number;
  columnGroup?: number;
  resourceGroup?: number;
  boundaryGroup?: number;
}

const PATTERNS: PatternDefinition[] = [
  // Canonical Cfx resource frames: @resource/path.lua:12:4.
  {
    expression: new RegExp(`(@(${RESOURCE_NAME})[\\\\/]${RESOURCE_FILE})\\s*:([0-9]{1,9})(?:\\s*:([0-9]{1,9}))?${LOCATION_END}`, "gi"),
    kind: "resource", labelGroup: 1, resourceGroup: 2, sourceGroup: 3, lineGroup: 4, columnGroup: 5,
  },
  {
    expression: new RegExp(`(@(${RESOURCE_NAME})[\\\\/]${RESOURCE_FILE})\\s*:line\\s+([0-9]{1,9})${LOCATION_END}`, "gi"),
    kind: "resource", labelGroup: 1, resourceGroup: 2, sourceGroup: 3, lineGroup: 4,
  },
  // The same resource reference occasionally appears as resource:/name/path.
  {
    expression: new RegExp(`((?:resources?):[\\\\/]+(${RESOURCE_NAME})[\\\\/]${RESOURCE_FILE})\\s*:([0-9]{1,9})(?:\\s*:([0-9]{1,9}))?${LOCATION_END}`, "gi"),
    kind: "resource", labelGroup: 1, resourceGroup: 2, sourceGroup: 3, lineGroup: 4, columnGroup: 5,
  },
  // Windows/.NET frames may include spaces and either :line:column or :line N.
  {
    expression: new RegExp(`(^|[\\s(\"'=])${WINDOWS_FILE}\\s*:([0-9]{1,9})(?:\\s*:([0-9]{1,9}))?${LOCATION_END}`, "gi"),
    kind: "absolute", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3, columnGroup: 4,
  },
  {
    expression: new RegExp(`(^|[\\s(\"'=])${WINDOWS_FILE}\\s*:line\\s+([0-9]{1,9})${LOCATION_END}`, "gi"),
    kind: "absolute", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3,
  },
  {
    expression: new RegExp(`(^|[\\s(\"'=])${WINDOWS_FILE}\\s*\\(([0-9]{1,9})\\s*,\\s*([0-9]{1,9})\\)`, "gi"),
    kind: "absolute", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3, columnGroup: 4,
  },
  // Profile-relative paths are useful for server.cfg and explicitly rooted resources/ paths.
  {
    expression: new RegExp(`(^|[\\s(\"'=])((?:resources)[\\\\/]${RESOURCE_FILE.slice(1, -1)})\\s*:([0-9]{1,9})(?:\\s*:([0-9]{1,9}))?${LOCATION_END}`, "gi"),
    kind: "profile", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3, columnGroup: 4,
  },
  // Resource-relative stack frames and source-map paths rely on a resource hint in the line.
  // Paths containing spaces need an unambiguous opening delimiter or stack-frame prefix so
  // the parser does not turn just the suffix after the final space into a source link.
  {
    expression: new RegExp(`(^|[('\"=]|\\b(?:at|in)\\s+)${RELATIVE_FILE_WITH_SPACES}\\s*:([0-9]{1,9})(?:\\s*:([0-9]{1,9}))?${LOCATION_END}`, "gi"),
    kind: "relative", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3, columnGroup: 4,
  },
  {
    expression: new RegExp(`(^|[('\"=]|\\b(?:at|in)\\s+)${RELATIVE_FILE_WITH_SPACES}\\s*:line\\s+([0-9]{1,9})${LOCATION_END}`, "gi"),
    kind: "relative", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3,
  },
  {
    expression: new RegExp(`(^|[('\"=]|\\b(?:at|in)\\s+)${RELATIVE_FILE_WITH_SPACES}\\s*\\(([0-9]{1,9})\\s*,\\s*([0-9]{1,9})\\)`, "gi"),
    kind: "relative", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3, columnGroup: 4,
  },
  {
    expression: new RegExp(`(^|[\\s(\"'=])${RELATIVE_FILE}\\s*:([0-9]{1,9})(?:\\s*:([0-9]{1,9}))?${LOCATION_END}`, "gi"),
    kind: "relative", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3, columnGroup: 4,
  },
  {
    expression: new RegExp(`(^|[\\s(\"'=])${RELATIVE_FILE}\\s*:line\\s+([0-9]{1,9})${LOCATION_END}`, "gi"),
    kind: "relative", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3,
  },
  {
    expression: new RegExp(`(^|[\\s(\"'=])${RELATIVE_FILE}\\s*\\(([0-9]{1,9})\\s*,\\s*([0-9]{1,9})\\)`, "gi"),
    kind: "relative", boundaryGroup: 1, labelGroup: 2, sourceGroup: 2, lineGroup: 3, columnGroup: 4,
  },
];

function maskFormatting(value: string): string {
  const blank = (match: string) => " ".repeat(match.length);
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, blank)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, blank)
    .replace(/\^[0-9]/g, blank);
}

function coordinate(value: string | undefined, maximum: number, allowZero = false): number | null {
  if (!value || !/^[0-9]{1,9}$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum || (!allowZero && parsed < 1)) return null;
  return parsed;
}

function sourceFile(value: string): string | null {
  const source = value.trim();
  if (!source || source.length > MAX_SOURCE_LENGTH || /[\u0000-\u001f]/.test(source)) return null;
  if (!new RegExp(`\\.${SOURCE_EXTENSION}$`, "i").test(source)) return null;
  if (source.includes(":") && !/^[A-Za-z]:[\\\\/][^:]*$/.test(source)) return null;
  if (/^(?:citizen|node|https?|webpack|file):/i.test(source)) return null;
  return source;
}

function inferredResource(line: string): string | undefined {
  const scriptPrefix = line.match(/\[\s*(?:script|resources?):([A-Za-z0-9_.-]{1,128})\s*\]/i);
  if (scriptPrefix) return scriptPrefix[1];
  const channelPrefix = line.match(/(?:^|\s)(?:script|resources?):([A-Za-z0-9_.-]{1,128})(?=$|\s)/i);
  if (channelPrefix) return channelPrefix[1];
  let explicit: string | undefined;
  for (const match of line.matchAll(/\bresource\s+([A-Za-z0-9_.-]{1,128})\b/gi)) explicit = match[1];
  return explicit;
}

function hasUnsafeSegments(source: string): boolean {
  return source.split(/[\\/]/).some((part) => part === "." || part === "..");
}

function hasUnambiguousBareRelativeStart(line: string, start: number): boolean {
  if (start === 0) return true;
  return /(?:[(\"'=]|\b(?:at|in)\s+|\[\s*(?:script|resources?):[A-Za-z0-9_.-]{1,128}\s*\]\s+|(?:^|\s)(?:script|resources?):[A-Za-z0-9_.-]{1,128}\s+)$/i.test(line.slice(0, start));
}

function rangesOverlap(left: ConsoleSourceMatch, right: ConsoleSourceMatch): boolean {
  return left.start < right.end && right.start < left.end;
}

/** Extract source-bearing portions of one console line without changing its displayed text. */
export function parseConsoleSourceLocations(line: string): ConsoleSourceMatch[] {
  if (!line) return [];
  const bounded = line.slice(0, MAX_PARSED_LINE_LENGTH);
  const parseable = maskFormatting(bounded);
  const resourceHint = inferredResource(parseable);
  const found: ConsoleSourceMatch[] = [];

  LOAD_SCRIPT.lastIndex = 0;
  for (const match of parseable.matchAll(LOAD_SCRIPT)) {
    const source = sourceFile(match[1]);
    const lineNumber = coordinate(match[3], MAX_LINE);
    const columnNumber = coordinate(match[4], MAX_COLUMN, true);
    if (!source || !lineNumber || columnNumber === null || hasUnsafeSegments(source)) continue;
    const start = match.index + match[0].indexOf(match[1]);
    found.push({
      kind: "relative",
      source,
      resourceName: match[2],
      line: lineNumber,
      column: Math.max(1, columnNumber),
      start,
      end: start + match[1].length,
    });
  }

  for (const definition of PATTERNS) {
    definition.expression.lastIndex = 0;
    for (const match of parseable.matchAll(definition.expression)) {
      const source = sourceFile(match[definition.sourceGroup]);
      const lineNumber = coordinate(match[definition.lineGroup], MAX_LINE);
      const rawColumn = definition.columnGroup ? match[definition.columnGroup] : undefined;
      const columnNumber = rawColumn === undefined ? 1 : coordinate(rawColumn, MAX_COLUMN, true);
      if (!source || !lineNumber || columnNumber === null) continue;

      const resourceName = definition.resourceGroup ? match[definition.resourceGroup] : resourceHint;
      let kind = definition.kind;
      if (kind === "relative" && source.toLowerCase() === "server.cfg" && !resourceName) kind = "profile";
      if (kind === "relative" && source.startsWith("@")) continue;
      if (kind === "relative" && !resourceName) continue;
      if ((kind === "resource" || kind === "profile") && hasUnsafeSegments(source)) continue;

      const boundaryLength = definition.boundaryGroup ? match[definition.boundaryGroup].length : 0;
      const start = match.index + boundaryLength;
      if (kind === "relative" && !/[\\/]/.test(source) && !hasUnambiguousBareRelativeStart(parseable, start)) continue;
      const end = match.index + match[0].length;
      found.push({
        kind,
        source,
        ...(resourceName ? { resourceName } : {}),
        line: lineNumber,
        column: Math.max(1, columnNumber),
        start,
        end,
      });
    }
  }

  const ordered = found.sort((left, right) => left.start - right.start || right.end - left.end);
  const nonOverlapping: ConsoleSourceMatch[] = [];
  for (const candidate of ordered) {
    if (!nonOverlapping.some((existing) => rangesOverlap(existing, candidate))) nonOverlapping.push(candidate);
  }
  return nonOverlapping;
}
