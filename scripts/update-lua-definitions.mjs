import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import yauzl from "yauzl";

import { verifyLuaDefinitions } from "./verify-lua-definitions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = path.join(root, "scripts");
const resourcesRoot = path.join(root, "fivem-studio", "resources");
const target = path.join(resourcesRoot, "lua-library");
const release = readJson(path.join(scriptsRoot, "lua-definitions-release.json"));
const redmAllowlistPath = path.join(scriptsRoot, "redm-platform-allowlist.json");
const redmAllowlist = readJson(redmAllowlistPath);

validateRelease(release);
validateAllowlist(redmAllowlist);

const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
const tempRoot = path.join(os.tmpdir(), `qb-studio-lua-definitions-${nonce}`);
const archivePath = path.join(tempRoot, "fivem-lls-addon.zip");
const platformPath = path.join(tempRoot, "natives-platform.json");
const staging = path.join(resourcesRoot, `.lua-library-${nonce}`);
const backup = path.join(resourcesRoot, `.lua-library-backup-${nonce}`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
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

function assertSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function validateRelease(value) {
  if (!value || value.schemaVersion !== 1) throw new Error("Unsupported Lua definition release manifest.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.reviewedAt ?? "")) {
    throw new Error("The Lua definition release must record its review date.");
  }
  if (!value.addon || !/^[a-f0-9]{40}$/.test(value.addon.commit ?? "")) {
    throw new Error("The Lua definition addon must be pinned to an exact commit.");
  }
  if (!String(value.addon.archiveUrl ?? "").includes(value.addon.commit)) {
    throw new Error("The Lua definition addon URL must contain its pinned commit.");
  }
  if (value.addon.archiveRoot !== `fivem-lls-addon-${value.addon.commit}`) {
    throw new Error("The pinned addon archive root is invalid.");
  }
  if (value.addon.license !== "MIT" || value.addon.licensePath !== "LICENSE") {
    throw new Error("The pinned addon license declaration is invalid.");
  }
  assertSha(value.addon.archiveSha256, "Addon archive checksum");
  assertSha(value.addon.licenseSha256, "Addon license checksum");
  if (!Number.isSafeInteger(value.addon.archiveBytes) || value.addon.archiveBytes <= 0) {
    throw new Error("The addon archive must record its exact byte length.");
  }
  if (!value.platformNatives || value.platformNatives.namespace !== "CFX") {
    throw new Error("The official platform-native namespace declaration is invalid.");
  }
  assertSha(value.platformNatives.sha256, "Platform-native checksum");
  if (!Number.isSafeInteger(value.platformNatives.bytes) || value.platformNatives.bytes <= 0) {
    throw new Error("The platform-native source must record its exact byte length.");
  }
}

function validateAllowlist(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.names) || value.names.length < 25) {
    throw new Error("The RedM platform allowlist is invalid or unexpectedly small.");
  }
  const sorted = [...value.names].sort();
  if (new Set(value.names).size !== value.names.length || sorted.some((name, index) => name !== value.names[index])) {
    throw new Error("The RedM platform allowlist must contain unique, sorted names.");
  }
  if (!value.names.every((name) => /^[A-Z_][A-Z0-9_]*$/.test(name))) {
    throw new Error("The RedM platform allowlist contains an invalid native name.");
  }
}

function assertInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe definition path: ${child}`);
  }
}

function safeWrite(base, relativePath, bytes) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Unsafe definition output path: ${relativePath}`);
  }
  const output = path.resolve(base, ...normalized.split("/"));
  assertInside(base, output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes, { flag: "wx" });
}

async function download(url, destination, expectedSha256, expectedBytes, label, maximumBytes) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`${label} URL must use HTTPS.`);
  const response = await fetch(parsed, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${label} download failed with HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`${label} exceeds the download size limit.`);
  }
  let received = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maximumBytes) throw new Error(`${label} exceeds the download size limit.`);
      controller.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body.pipeThrough(limiter)), fs.createWriteStream(destination, { flags: "wx" }));
  const actualBytes = fs.statSync(destination).size;
  if (actualBytes !== expectedBytes) throw new Error(`${label} byte length mismatch: received ${actualBytes}.`);
  const actual = sha256File(destination);
  if (actual !== expectedSha256) throw new Error(`${label} checksum mismatch: received ${actual}.`);
}

function openZip(archive) {
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Could not open the definition archive."));
      else resolve(zip);
    });
  });
}

function readZipEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Could not read ${entry.fileName}.`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) stream.destroy(new Error(`Definition file is unexpectedly large: ${entry.fileName}`));
        else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function extractAddon(archive, destination) {
  const zip = await openZip(archive);
  const prefix = `${release.addon.archiveRoot}/`;
  const counts = { runtime: 0, fivemGame: 0, redmGame: 0, plugin: 0, license: 0 };
  let entries = 0;
  let expandedBytes = 0;

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", async (entry) => {
      try {
        entries += 1;
        expandedBytes += entry.uncompressedSize;
        if (entries > 10_000 || expandedBytes > 50 * 1024 * 1024) {
          throw new Error("The addon archive exceeds the extraction safety limits.");
        }
        const normalized = entry.fileName.replaceAll("\\", "/");
        if (normalized.startsWith("/") || normalized.split("/").includes("..") || /^[A-Za-z]:/.test(normalized)) {
          throw new Error(`Unsafe path in definition archive: ${entry.fileName}`);
        }
        if (normalized.endsWith("/")) {
          zip.readEntry();
          return;
        }
        if (!normalized.startsWith(prefix)) throw new Error(`Unexpected archive root: ${entry.fileName}`);
        const sourcePath = normalized.slice(prefix.length);
        let bytes;

        if (sourcePath === "LICENSE") {
          bytes = await readZipEntry(zip, entry);
          if (sha256Buffer(bytes) !== release.addon.licenseSha256) throw new Error("The addon license checksum is invalid.");
          safeWrite(destination, "THIRD_PARTY_LICENSES/overextended-fivem-lls-addon-MIT.txt", bytes);
          counts.license += 1;
        } else if (sourcePath === "plugin.lua") {
          bytes = await readZipEntry(zip, entry);
          safeWrite(destination, "plugin.lua", bytes);
          counts.plugin += 1;
        } else {
          const runtimeMatch = sourcePath.match(/^library\/runtime\/([^/]+\.lua)$/);
          const fivemMatch = sourcePath.match(/^library\/natives\/GTAV\/([^/]+\.lua)$/);
          const redmMatch = sourcePath.match(/^library\/natives\/RDR3\/([^/]+\.lua)$/);
          if (runtimeMatch) {
            bytes = await readZipEntry(zip, entry);
            safeWrite(destination, `fivem/runtime/${runtimeMatch[1]}`, bytes);
            safeWrite(destination, `redm/runtime/${runtimeMatch[1]}`, bytes);
            counts.runtime += 1;
          } else if (fivemMatch) {
            bytes = await readZipEntry(zip, entry);
            safeWrite(destination, `fivem/natives/game/${fivemMatch[1]}`, bytes);
            counts.fivemGame += 1;
          } else if (redmMatch) {
            bytes = await readZipEntry(zip, entry);
            safeWrite(destination, `redm/natives/game/${redmMatch[1]}`, bytes);
            counts.redmGame += 1;
          }
        }
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });

  if (counts.runtime !== 7 || counts.fivemGame !== 44 || counts.redmGame !== 86 || counts.plugin !== 1 || counts.license !== 1) {
    throw new Error(`The pinned addon contents changed unexpectedly: ${JSON.stringify(counts)}.`);
  }
  return counts;
}

const luaTypeByNativeType = new Map([
  ["Any", "any"],
  ["Any*", "any"],
  ["Blip", "integer"],
  ["Blip*", "integer"],
  ["BOOL", "boolean"],
  ["BOOL*", "boolean"],
  ["bool", "boolean"],
  ["Cam", "integer"],
  ["char*", "string"],
  ["Entity", "integer"],
  ["Entity*", "integer"],
  ["float", "number"],
  ["float*", "number"],
  ["func", "function"],
  ["Hash", "integer"],
  ["Hash*", "integer"],
  ["int", "integer"],
  ["int*", "integer"],
  ["long", "integer"],
  ["Object", "integer"],
  ["object", "any"],
  ["Ped", "integer"],
  ["Player", "integer"],
  ["Vector3", "vector3"],
  ["Vector3*", "vector3"],
  ["Vehicle", "integer"],
  ["void", "void"],
]);

const luaKeywords = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local",
  "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
]);

function luaType(nativeType) {
  const result = luaTypeByNativeType.get(nativeType);
  if (!result) throw new Error(`Unsupported platform-native type: ${nativeType}`);
  return result;
}

function luaFunctionName(nativeName) {
  const result = nativeName
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new Error(`Invalid generated native name: ${nativeName}`);
  return result;
}

function luaParameterName(name, used) {
  let result = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "value";
  if (luaKeywords.has(result)) result = `${result}Value`;
  let unique = result;
  let suffix = 2;
  while (used.has(unique)) unique = `${result}${suffix++}`;
  used.add(unique);
  return unique;
}

function generatePlatformLua(records, productName) {
  const functions = new Set();
  const blocks = [
    "---@meta",
    "",
    `-- Generated platform-native definitions for the ${productName} product pack.`,
    "-- Do not edit this file manually; run npm run update:lua-definitions.",
    "",
  ];
  for (const native of [...records].sort((a, b) => a.name.localeCompare(b.name) || a.hash.localeCompare(b.hash))) {
    if (!native || !/^[A-Z_][A-Z0-9_]*$/.test(native.name) || !/^0x[A-Fa-f0-9]+$/.test(native.hash)) {
      throw new Error("The platform-native dataset contains an invalid record.");
    }
    if (!Array.isArray(native.params) || !["client", "server", "shared"].includes(native.apiset)) {
      throw new Error(`The platform-native record ${native.name} has an invalid signature or API set.`);
    }
    const functionName = luaFunctionName(native.name);
    if (functions.has(functionName)) throw new Error(`Duplicate generated function name: ${functionName}`);
    functions.add(functionName);
    blocks.push(`---**${productName} platform** \`${native.apiset}\``);
    blocks.push(`---[Native documentation](https://docs.fivem.net/natives/?_${native.hash})`);
    const usedNames = new Set();
    const parameterNames = [];
    for (const parameter of native.params) {
      const parameterName = luaParameterName(String(parameter.name ?? "value"), usedNames);
      parameterNames.push(parameterName);
      blocks.push(`---@param ${parameterName} ${luaType(parameter.type)}`);
    }
    const resultType = luaType(native.results);
    if (resultType !== "void") blocks.push(`---@return ${resultType}`);
    blocks.push(`function ${functionName}(${parameterNames.join(", ")}) end`, "");
  }
  return { content: `${blocks.join("\n")}\n`, functionCount: functions.size };
}

function generatePlatformFiles(platformBytes, destination) {
  let document;
  try {
    document = JSON.parse(platformBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`The verified platform-native JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const namespace = document?.[release.platformNatives.namespace];
  if (!namespace || typeof namespace !== "object" || Array.isArray(namespace)) {
    throw new Error("The verified platform-native JSON is missing its expected namespace.");
  }
  const records = Object.values(namespace);
  if (records.length < 900) throw new Error("The platform-native dataset is unexpectedly small.");
  const names = new Map(records.map((record) => [record.name, record]));
  const allowed = new Set(redmAllowlist.names);
  for (const name of allowed) {
    const record = names.get(name);
    if (!record || record.game !== undefined) throw new Error(`RedM allowlisted native is absent or no longer game-unspecified: ${name}`);
  }

  const fivemRecords = records.filter((record) => record.game === undefined || record.game === "gta5");
  const redmRecords = records.filter((record) => record.game === "rdr3" || (record.game === undefined && allowed.has(record.name)));
  if (fivemRecords.some((record) => record.game === "rdr3") || redmRecords.some((record) => record.game === "gta5")) {
    throw new Error("Platform-native target filtering leaked a game-specific record.");
  }

  const fivem = generatePlatformLua(fivemRecords, "FiveM");
  const redm = generatePlatformLua(redmRecords, "RedM");
  safeWrite(destination, "fivem/natives/platform.lua", fivem.content);
  safeWrite(destination, "redm/natives/platform.lua", redm.content);
  return { sourceRecords: records.length, fivemFunctions: fivem.functionCount, redmFunctions: redm.functionCount };
}

function copyCuratedQbcore(destination) {
  const sourceRoot = path.join(target, "qbcore");
  const rootInfo = fs.lstatSync(sourceRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("The curated QBCore definition pack is missing.");
  let files = 0;
  let bytes = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`The curated QBCore pack may not contain symbolic links: ${absolute}`);
      if (info.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!info.isFile() || path.extname(entry.name).toLowerCase() !== ".lua" || info.size > 500 * 1024) {
        throw new Error(`Unsupported curated QBCore definition file: ${absolute}`);
      }
      const relative = path.relative(sourceRoot, absolute).replaceAll("\\", "/");
      safeWrite(destination, `qbcore/${relative}`, fs.readFileSync(absolute));
      files += 1;
      bytes += info.size;
    }
  };
  visit(sourceRoot);
  if (files < 1 || bytes < 4_000 || bytes > 5 * 1024 * 1024) {
    throw new Error("The curated QBCore definition pack is missing, incomplete, or unexpectedly large.");
  }
}

function writePlatformSourceNotice(destination) {
  const notice = [
    "QB Studio platform-native signature source notice",
    "",
    `Source: ${release.platformNatives.source}`,
    `Reviewed SHA-256: ${release.platformNatives.sha256}`,
    "Provider: CitizenFX Collective / Cfx.re",
    "",
    "QB Studio generates only factual native names, hashes, API sets, parameter names/types,",
    "and result types from this dataset. Upstream descriptions, examples, and prose parameter",
    "or result documentation are not copied. Each generated declaration links to the upstream",
    "native reference for documentation.",
    "",
  ].join("\n");
  safeWrite(destination, "THIRD_PARTY_LICENSES/CitizenFX-platform-native-source-NOTICE.txt", notice);
}

function listFiles(base) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in definition packs: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`Unsupported filesystem entry in definition packs: ${absolute}`);
    }
  };
  visit(base);
  return files;
}

function sourceFor(relativePath) {
  if (relativePath === "qbcore/qbcore.lua") return "qbcore-curated";
  if (relativePath.endsWith("/natives/platform.lua") || relativePath.endsWith("CitizenFX-platform-native-source-NOTICE.txt")) {
    return "official-platform-json";
  }
  return "overextended-addon";
}

function writeBundleManifest(destination, addonCounts, platformCounts) {
  const files = listFiles(destination).map((absolute) => {
    const relativePath = path.relative(destination, absolute).replaceAll("\\", "/");
    const stat = fs.statSync(absolute);
    return { path: relativePath, bytes: stat.size, sha256: sha256File(absolute), source: sourceFor(relativePath) };
  });
  const manifest = {
    schemaVersion: 1,
    reviewedAt: release.reviewedAt,
    productPacks: ["fivem", "redm", "qbcore"],
    sources: {
      addon: {
        repository: release.addon.repository,
        commit: release.addon.commit,
        archiveUrl: release.addon.archiveUrl,
        archiveBytes: release.addon.archiveBytes,
        archiveSha256: release.addon.archiveSha256,
        license: release.addon.license,
      },
      platformNatives: {
        source: release.platformNatives.source,
        bytes: release.platformNatives.bytes,
        sha256: release.platformNatives.sha256,
        etag: release.platformNatives.etag,
        lastModified: release.platformNatives.lastModified,
        redmCommonAllowlistSha256: sha256File(redmAllowlistPath),
      },
      qbcore: { maintenance: "curated", path: "qbcore/qbcore.lua" },
    },
    composition: {
      fivem: ["addon-runtime", "addon-gtav-natives", "filtered-platform-natives"],
      redm: ["addon-runtime", "addon-rdr3-natives", "filtered-platform-natives"],
      qbcore: ["curated-qbcore"],
    },
    counts: { addon: addonCounts, platform: platformCounts },
    files,
  };
  safeWrite(destination, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

function installStaging() {
  let movedCurrent = false;
  try {
    assertInside(resourcesRoot, target);
    assertInside(resourcesRoot, staging);
    assertInside(resourcesRoot, backup);
    if (fs.existsSync(backup)) throw new Error("Definition backup path already exists.");
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedCurrent = true;
    }
    fs.renameSync(staging, target);
    if (movedCurrent) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (movedCurrent && !fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
}

fs.mkdirSync(tempRoot, { recursive: false });
fs.mkdirSync(staging, { recursive: false });

try {
  console.log(`Downloading reviewed definition addon commit ${release.addon.commit}...`);
  await download(
    release.addon.archiveUrl,
    archivePath,
    release.addon.archiveSha256,
    release.addon.archiveBytes,
    "Definition addon",
    10 * 1024 * 1024,
  );
  console.log("Downloading the checksum-pinned official platform-native dataset...");
  await download(
    release.platformNatives.source,
    platformPath,
    release.platformNatives.sha256,
    release.platformNatives.bytes,
    "Platform-native dataset",
    10 * 1024 * 1024,
  );

  copyCuratedQbcore(staging);
  const addonCounts = await extractAddon(archivePath, staging);
  const platformCounts = generatePlatformFiles(fs.readFileSync(platformPath), staging);
  writePlatformSourceNotice(staging);
  writeBundleManifest(staging, addonCounts, platformCounts);
  verifyLuaDefinitions(staging, {
    releasePath: path.join(scriptsRoot, "lua-definitions-release.json"),
    allowlistPath: redmAllowlistPath,
  });
  installStaging();
  console.log(
    `Prepared source-backed FiveM (${platformCounts.fivemFunctions} platform functions), RedM (${platformCounts.redmFunctions} platform functions), and curated QBCore definition packs.`,
  );
} finally {
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
}
