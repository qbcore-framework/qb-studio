import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const sourceCatalogRoot = path.join(repositoryRoot, "fivem-studio", "resources", "resource-templates");
const MAX_TEMPLATE_FILES = 64;
const MAX_TEMPLATE_DEPTH = 8;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const RESOURCE_NAME_PLACEHOLDER = "__QB_RESOURCE_NAME__";
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const VITE_NODE_ENGINE = "^20.19.0 || >=22.12.0";

const templates = {
  "static-nui": {
    required: ["html/index.html", "html/script.js", "html/style.css"],
    placeholderFiles: [],
  },
  "react-nui": {
    required: [
      "README.md",
      "THIRD_PARTY_NOTICES.txt",
      "html/.gitignore",
      "html/index.html",
      "html/package.json",
      "html/package-lock.json",
      "html/vite.config.js",
      "html/src/App.jsx",
      "html/src/main.jsx",
      "html/src/style.css",
      "html/dist/index.html",
    ],
    placeholderFiles: [],
  },
  "vue-nui": {
    required: [
      "README.md",
      "THIRD_PARTY_NOTICES.txt",
      "html/.gitignore",
      "html/index.html",
      "html/package.json",
      "html/package-lock.json",
      "html/vite.config.js",
      "html/src/App.vue",
      "html/src/main.js",
      "html/src/style.css",
      "html/dist/index.html",
    ],
    placeholderFiles: [],
  },
};

function fail(message) {
  throw new Error(`Resource template verification failed: ${message}`);
}

function requireOrdinaryDirectory(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail(`${label} is missing.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be an ordinary directory.`);
}

function sortedEntries(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));
}

function readTemplateFiles(catalogRoot, template) {
  const templateRoot = path.join(catalogRoot, template);
  requireOrdinaryDirectory(templateRoot, `${template} template`);
  const pending = [{ directory: templateRoot, relative: "", depth: 0 }];
  const files = new Map();
  let totalBytes = 0;

  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current.depth > MAX_TEMPLATE_DEPTH) fail(`${template} exceeds ${MAX_TEMPLATE_DEPTH} directory levels.`);
    for (const entry of sortedEntries(current.directory)) {
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isSymbolicLink()) fail(`${template}/${relative} is a symbolic link or junction.`);
      if (entry.isDirectory()) {
        if (["node_modules", ".git"].includes(entry.name)) fail(`${template}/${relative} is a forbidden directory.`);
        pending.push({ directory: absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) fail(`${template}/${relative} is not an ordinary file.`);
      if (files.size >= MAX_TEMPLATE_FILES) fail(`${template} exceeds ${MAX_TEMPLATE_FILES} files.`);
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`${template}/${relative} is not an ordinary file.`);
      if (stat.size > MAX_TEMPLATE_BYTES - totalBytes) fail(`${template} exceeds ${MAX_TEMPLATE_BYTES} bytes.`);
      const bytes = fs.readFileSync(absolute);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TEMPLATE_BYTES) fail(`${template} exceeds ${MAX_TEMPLATE_BYTES} bytes.`);
      if (bytes.includes(0)) fail(`${template}/${relative} is not a text file.`);
      if (/\.map$/i.test(relative)) fail(`${template}/${relative} is a source map.`);
      const content = bytes.toString("utf8");
      if (/[/#@]\s*sourceMappingURL\s*=/i.test(content)) fail(`${template}/${relative} embeds a source-map reference.`);
      files.set(relative, content);
    }
  }
  return files;
}

function assertRequiredFiles(template, files, required) {
  for (const relative of required) {
    if (!files.has(relative)) fail(`${template} is missing ${relative}.`);
  }
}

function assertPlaceholders(template, files, expectedFiles) {
  const expected = new Set(expectedFiles);
  for (const [relative, content] of files) {
    const occurrences = content.split(RESOURCE_NAME_PLACEHOLDER).length - 1;
    if (expected.has(relative) && occurrences !== 1) {
      fail(`${template}/${relative} must contain exactly one reviewed resource-name placeholder.`);
    }
    if (!expected.has(relative) && occurrences !== 0) {
      fail(`${template}/${relative} contains an unexpected resource-name placeholder.`);
    }
    const substituted = content.replaceAll(RESOURCE_NAME_PLACEHOLDER, "verified-resource");
    if (substituted.includes(RESOURCE_NAME_PLACEHOLDER) || /__QB_[A-Z0-9_]*__/.test(substituted)) {
      fail(`${template}/${relative} contains an unresolved QB Studio placeholder.`);
    }
  }
}

function assertNoRemoteCodeOrStyles(template, files) {
  for (const [relative, content] of files) {
    if (/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["'](?:https?:)?\/\//i.test(content)) {
      fail(`${template}/${relative} imports code from a remote URL.`);
    }
    if (/\bimport\s*\(\s*["'](?:https?:)?\/\//i.test(content)) {
      fail(`${template}/${relative} dynamically imports code from a remote URL.`);
    }
    if (/<script\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\//i.test(content)) {
      fail(`${template}/${relative} loads a remote script.`);
    }
    if (/<link\b[^>]*\bhref\s*=\s*["'](?:https?:)?\/\//i.test(content)) {
      fail(`${template}/${relative} loads a remote stylesheet.`);
    }
    if (/@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//i.test(content)) {
      fail(`${template}/${relative} imports a remote stylesheet.`);
    }
  }
}

function assertNuiCallbackPolicy(template, files) {
  const pages = template === "static-nui"
    ? ["html/index.html"]
    : ["html/index.html", "html/dist/index.html"];
  for (const page of pages) {
    const content = files.get(page);
    if (!/connect-src\s+'self'\s+https:/i.test(content)) {
      fail(`${template}/${page} must allow same-origin and Cfx HTTPS NUI callbacks.`);
    }
    if (template !== "static-nui" && !/connect-src[^;]*\bws:\s+wss:/i.test(content)) {
      fail(`${template}/${page} must allow Vite's local development WebSocket.`);
    }
    if (/connect-src[^;]*https:\/\/[A-Za-z0-9_.-]+/i.test(content)) {
      fail(`${template}/${page} must not encode a resource name as a CSP host source.`);
    }
  }
}

function parseJson(template, files, relative) {
  try {
    return JSON.parse(files.get(relative));
  } catch (error) {
    fail(`${template}/${relative} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertExactDependencies(template, packageJson, packageLock) {
  if (packageJson.private !== true || !EXACT_VERSION.test(packageJson.version ?? "")) {
    fail(`${template} package metadata must be private and use an exact version.`);
  }
  if (packageJson.engines?.node !== VITE_NODE_ENGINE) {
    fail(`${template} must declare the Vite-compatible Node.js engine ${VITE_NODE_ENGINE}.`);
  }
  const groups = ["dependencies", "devDependencies"];
  for (const group of groups) {
    const dependencies = packageJson[group] ?? {};
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      fail(`${template} ${group} must be an object.`);
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
        fail(`${template} must pin ${name} to an exact version, found ${String(version)}.`);
      }
    }
  }

  const rootLock = packageLock.packages?.[""];
  if (packageLock.lockfileVersion !== 3 || packageLock.requires !== true || !rootLock) {
    fail(`${template} package-lock.json must be a complete npm lockfile v3.`);
  }
  if (rootLock.name !== packageJson.name || rootLock.version !== packageJson.version) {
    fail(`${template} package-lock root identity disagrees with package.json.`);
  }
  if (rootLock.engines?.node !== packageJson.engines.node) {
    fail(`${template} package-lock root Node.js engine disagrees with package.json.`);
  }
  for (const group of groups) {
    if (JSON.stringify(rootLock[group] ?? {}) !== JSON.stringify(packageJson[group] ?? {})) {
      fail(`${template} package-lock root ${group} disagrees with package.json.`);
    }
    for (const [name, version] of Object.entries(packageJson[group] ?? {})) {
      const locked = packageLock.packages?.[`node_modules/${name}`];
      if (!locked || locked.version !== version || typeof locked.integrity !== "string" || !locked.integrity.startsWith("sha512-")) {
        fail(`${template} lockfile does not pin ${name}@${version} with SHA-512 integrity.`);
      }
    }
  }
  for (const [location, locked] of Object.entries(packageLock.packages ?? {})) {
    if (location && (!locked || typeof locked !== "object" || !EXACT_VERSION.test(locked.version ?? ""))) {
      fail(`${template} lock entry ${location} does not contain an exact version.`);
    }
  }
}

function assertFrameworkAssets(template, files) {
  const packageJson = parseJson(template, files, "html/package.json");
  const packageLock = parseJson(template, files, "html/package-lock.json");
  assertExactDependencies(template, packageJson, packageLock);
  if (!/\bsourcemap\s*:\s*false\b/.test(files.get("html/vite.config.js"))) {
    fail(`${template} must explicitly disable production source maps.`);
  }

  const distFiles = [...files.keys()].filter((relative) => relative.startsWith("html/dist/"));
  if (!distFiles.some((relative) => /^html\/dist\/assets\/[^/]+\.js$/.test(relative))) {
    fail(`${template} is missing a prebuilt JavaScript asset.`);
  }
  if (!distFiles.some((relative) => /^html\/dist\/assets\/[^/]+\.css$/.test(relative))) {
    fail(`${template} is missing a prebuilt stylesheet asset.`);
  }

  const distIndex = files.get("html/dist/index.html");
  const references = [...distIndex.matchAll(/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  if (references.length < 2) fail(`${template} dist/index.html must reference its prebuilt script and stylesheet.`);
  for (const reference of references) {
    if (!reference.startsWith("./") || /[?#]/.test(reference)) {
      fail(`${template} dist asset reference must be a plain relative path: ${reference}.`);
    }
    const resolved = path.posix.normalize(path.posix.join("html/dist", reference));
    if (!resolved.startsWith("html/dist/assets/") || !files.has(resolved)) {
      fail(`${template} dist asset reference is missing or leaves dist/assets: ${reference}.`);
    }
  }
}

export function verifyResourceTemplates(catalogRoot = sourceCatalogRoot) {
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  requireOrdinaryDirectory(resolvedCatalogRoot, "resource template catalog");
  const actualTemplates = sortedEntries(resolvedCatalogRoot);
  const expectedTemplates = Object.keys(templates).sort();
  if (
    actualTemplates.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) ||
    JSON.stringify(actualTemplates.map((entry) => entry.name)) !== JSON.stringify(expectedTemplates)
  ) {
    fail(`catalog entries must be exactly: ${expectedTemplates.join(", ")}.`);
  }

  let totalFiles = 0;
  for (const template of expectedTemplates) {
    const config = templates[template];
    const files = readTemplateFiles(resolvedCatalogRoot, template);
    assertRequiredFiles(template, files, config.required);
    assertPlaceholders(template, files, config.placeholderFiles);
    assertNoRemoteCodeOrStyles(template, files);
    assertNuiCallbackPolicy(template, files);
    if (template !== "static-nui") assertFrameworkAssets(template, files);
    totalFiles += files.size;
  }
  return { catalogRoot: resolvedCatalogRoot, templateCount: expectedTemplates.length, fileCount: totalFiles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = verifyResourceTemplates();
  console.log(`Verified ${result.templateCount} resource templates (${result.fileCount} bounded files) with local prebuilt assets and exact lockfiles.`);
}
