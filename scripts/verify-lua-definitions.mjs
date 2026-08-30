import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hashFile(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function listFiles(base) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Definition packs may not contain symbolic links: ${absolute}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push(absolute);
      else throw new Error(`Definition packs contain an unsupported filesystem entry: ${absolute}`);
    }
  };
  visit(base);
  return files;
}

function sameArray(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function requireText(filePath, expression, message) {
  if (!expression.test(fs.readFileSync(filePath, "utf8"))) throw new Error(message);
}

function forbidText(filePath, expression, message) {
  if (expression.test(fs.readFileSync(filePath, "utf8"))) throw new Error(message);
}

export function verifyLuaDefinitions(definitionRoot, options = {}) {
  const resolvedRoot = path.resolve(definitionRoot);
  const releasePath = options.releasePath ?? path.join(repositoryRoot, "scripts", "lua-definitions-release.json");
  const allowlistPath = options.allowlistPath ?? path.join(repositoryRoot, "scripts", "redm-platform-allowlist.json");
  const release = readJson(releasePath, "Lua definition release manifest");
  const allowlist = readJson(allowlistPath, "RedM platform allowlist");
  const manifestPath = path.join(resolvedRoot, "manifest.json");
  const manifest = readJson(manifestPath, "Bundled Lua definition manifest");

  if (
    manifest.schemaVersion !== 1 ||
    manifest.reviewedAt !== release.reviewedAt ||
    !sameArray(manifest.productPacks ?? [], ["fivem", "redm", "qbcore"])
  ) {
    throw new Error("The Lua definition bundle must declare exactly the FiveM, RedM, and QBCore product packs.");
  }
  if (
    manifest.sources?.addon?.repository !== release.addon?.repository ||
    manifest.sources?.addon?.commit !== release.addon?.commit ||
    manifest.sources?.addon?.archiveUrl !== release.addon?.archiveUrl ||
    manifest.sources?.addon?.archiveBytes !== release.addon?.archiveBytes ||
    manifest.sources?.addon?.archiveSha256 !== release.addon?.archiveSha256 ||
    manifest.sources?.addon?.license !== "MIT"
  ) {
    throw new Error("The bundled engine definitions do not match the reviewed addon release pin.");
  }
  if (
    manifest.sources?.platformNatives?.source !== release.platformNatives?.source ||
    manifest.sources?.platformNatives?.bytes !== release.platformNatives?.bytes ||
    manifest.sources?.platformNatives?.sha256 !== release.platformNatives?.sha256 ||
    manifest.sources?.platformNatives?.etag !== release.platformNatives?.etag ||
    manifest.sources?.platformNatives?.lastModified !== release.platformNatives?.lastModified ||
    manifest.sources?.platformNatives?.redmCommonAllowlistSha256 !== hashFile(allowlistPath)
  ) {
    throw new Error("The bundled platform definitions do not match their reviewed source and RedM allowlist pins.");
  }
  if (
    manifest.sources?.qbcore?.maintenance !== "curated" ||
    manifest.sources?.qbcore?.path !== "qbcore/qbcore.lua"
  ) {
    throw new Error("The QBCore definition pack must remain explicitly curated.");
  }

  const topLevel = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  const topNames = topLevel.map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  const expectedTopNames = ["fivem", "manifest.json", "plugin.lua", "qbcore", "redm", "THIRD_PARTY_LICENSES"]
    .sort((a, b) => a.localeCompare(b));
  if (!sameArray(topNames, expectedTopNames)) {
    throw new Error(`Unexpected top-level Lua definition content: ${topNames.join(", ")}.`);
  }
  for (const entry of topLevel) {
    if (/cfx/i.test(entry.name)) throw new Error("CFX must not be exposed as a fourth definition product pack.");
  }

  if (!Array.isArray(manifest.files) || manifest.files.length < 140) {
    throw new Error("The bundled Lua definition file manifest is unexpectedly small.");
  }
  const manifestPaths = manifest.files.map((file) => file?.path);
  if (
    manifestPaths.some((filePath) => typeof filePath !== "string" || filePath.includes("\\") || filePath.split("/").includes("..")) ||
    new Set(manifestPaths).size !== manifestPaths.length
  ) {
    throw new Error("The bundled Lua definition file manifest contains unsafe or duplicate paths.");
  }
  const sortedPaths = [...manifestPaths].sort((a, b) => a.localeCompare(b));
  if (!sameArray(manifestPaths, sortedPaths)) throw new Error("The bundled Lua definition file manifest is not deterministic.");

  const actualFiles = listFiles(resolvedRoot)
    .map((absolute) => path.relative(resolvedRoot, absolute).replaceAll("\\", "/"))
    .filter((relative) => relative !== "manifest.json");
  if (!sameArray(actualFiles, manifestPaths)) {
    const missing = manifestPaths.filter((filePath) => !actualFiles.includes(filePath));
    const unexpected = actualFiles.filter((filePath) => !manifestPaths.includes(filePath));
    throw new Error(`Lua definition files do not match the manifest. Missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`);
  }

  const counts = { fivem: 0, redm: 0, qbcore: 0 };
  for (const record of manifest.files) {
    if (!record || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || record.bytes > 500 * 1024) {
      throw new Error(`Definition file has an unsafe or invalid size: ${record?.path ?? "unknown"}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(record.sha256 ?? "")) throw new Error(`Definition file has an invalid checksum: ${record.path}.`);
    if (!["overextended-addon", "official-platform-json", "qbcore-curated"].includes(record.source)) {
      throw new Error(`Definition file has an unknown source classification: ${record.path}.`);
    }
    const absolute = path.resolve(resolvedRoot, ...record.path.split("/"));
    const relative = path.relative(resolvedRoot, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe manifest path: ${record.path}.`);
    const stat = fs.statSync(absolute);
    if (stat.size !== record.bytes || hashFile(absolute) !== record.sha256) {
      throw new Error(`Definition file does not match its reviewed manifest record: ${record.path}.`);
    }
    const product = record.path.split("/")[0];
    if (Object.hasOwn(counts, product)) counts[product] += 1;
  }

  if (counts.fivem !== 52 || counts.redm !== 94 || counts.qbcore < 1) {
    throw new Error(`Unexpected definition pack sizes: ${JSON.stringify(counts)}.`);
  }
  if (
    manifest.counts?.addon?.runtime !== 7 ||
    manifest.counts?.addon?.fivemGame !== 44 ||
    manifest.counts?.addon?.redmGame !== 86 ||
    manifest.counts?.addon?.plugin !== 1 ||
    manifest.counts?.addon?.license !== 1 ||
    manifest.counts?.platform?.sourceRecords !== 973 ||
    manifest.counts?.platform?.fivemFunctions !== 942 ||
    manifest.counts?.platform?.redmFunctions !== 219
  ) {
    throw new Error("The bundled definition counts do not match the reviewed source snapshot.");
  }

  const fivemRuntime = path.join(resolvedRoot, "fivem", "runtime");
  const redmRuntime = path.join(resolvedRoot, "redm", "runtime");
  const fivemRuntimeFiles = fs.readdirSync(fivemRuntime).sort();
  const redmRuntimeFiles = fs.readdirSync(redmRuntime).sort();
  if (!sameArray(fivemRuntimeFiles, redmRuntimeFiles) || fivemRuntimeFiles.length !== 7) {
    throw new Error("FiveM and RedM must contain the same reviewed runtime definition snapshot.");
  }
  for (const fileName of fivemRuntimeFiles) {
    if (hashFile(path.join(fivemRuntime, fileName)) !== hashFile(path.join(redmRuntime, fileName))) {
      throw new Error(`FiveM and RedM runtime definitions diverged: ${fileName}.`);
    }
  }

  const fivemPlatform = path.join(resolvedRoot, "fivem", "natives", "platform.lua");
  const redmPlatform = path.join(resolvedRoot, "redm", "natives", "platform.lua");
  requireText(fivemPlatform, /function CallMinimapScaleformFunction\(/, "FiveM platform definitions are missing a reviewed GTA-specific native.");
  forbidText(redmPlatform, /function CallMinimapScaleformFunction\(/, "A GTA-specific platform native leaked into the RedM pack.");
  requireText(redmPlatform, /function RegisterRawKeymap\(/, "RedM platform definitions are missing a reviewed RDR3-specific native.");
  forbidText(fivemPlatform, /function RegisterRawKeymap\(/, "An RDR3-specific platform native leaked into the FiveM pack.");
  requireText(
    path.join(resolvedRoot, "fivem", "natives", "game", "VEHICLE.lua"),
    /function SetVehicleParachuteActive\(/,
    "FiveM game-native definitions are incomplete.",
  );
  requireText(
    path.join(resolvedRoot, "redm", "natives", "game", "ANIMSCENE.lua"),
    /function CreateAnimScene\(/,
    "RedM game-native definitions are incomplete.",
  );
  requireText(
    path.join(resolvedRoot, "qbcore", "qbcore.lua"),
    /---@type QBCoreObject\s+QBCore = \{\}/,
    "The curated QBCore global is not connected to its completion type.",
  );
  requireText(path.join(fivemRuntime, "citizen.lua"), /function Citizen\.CreateThread\(/, "FiveM runtime definitions are incomplete.");
  requireText(path.join(redmRuntime, "citizen.lua"), /function Citizen\.CreateThread\(/, "RedM runtime definitions are incomplete.");

  const license = path.join(resolvedRoot, "THIRD_PARTY_LICENSES", "overextended-fivem-lls-addon-MIT.txt");
  if (hashFile(license) !== release.addon.licenseSha256) throw new Error("The bundled addon MIT license is missing or changed.");
  const platformNotice = path.join(
    resolvedRoot,
    "THIRD_PARTY_LICENSES",
    "CitizenFX-platform-native-source-NOTICE.txt",
  );
  requireText(
    platformNotice,
    /generates only factual native names, hashes, API sets, parameter names\/types/,
    "The official platform-native provenance and limited-use notice is missing.",
  );
  if (fs.statSync(fivemPlatform).size > 300 * 1024 || fs.statSync(redmPlatform).size > 100 * 1024) {
    throw new Error("Generated platform definitions unexpectedly contain excessive source prose.");
  }
  requireText(path.join(resolvedRoot, "plugin.lua"), /function OnSetText\(/, "The reviewed LuaLS syntax plugin is missing or incomplete.");

  return {
    productPacks: [...manifest.productPacks],
    fileCount: manifest.files.length,
    counts,
    sourceCommit: manifest.sources.addon.commit,
    platformFunctions: {
      fivem: manifest.counts.platform.fivemFunctions,
      redm: manifest.counts.platform.redmFunctions,
    },
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const definitionRoot = path.join(repositoryRoot, "fivem-studio", "resources", "lua-library");
  const result = verifyLuaDefinitions(definitionRoot);
  console.log(
    `Verified ${result.fileCount} source-backed Lua definition files across ${result.productPacks.join(", ")} at addon commit ${result.sourceCommit}.`,
  );
}
