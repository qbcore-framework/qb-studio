import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readText = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const readJson = (relative) => JSON.parse(readText(relative));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requiredNode = readText(".nvmrc").trim();
const rootPackage = readJson("package.json");
const desktopPackage = readJson("fivem-studio/package.json");
const runtimePackage = readJson("fivem-mcp-server/package.json");
const packageLock = readJson("package-lock.json");

assert(requiredNode === "24.20.0", ".nvmrc must pin the reviewed Node.js release.");
assert(rootPackage.packageManager === "npm@11.19.0", "packageManager must pin the npm version bundled with Node.js 24.20.0.");
assert(rootPackage.engines?.node === requiredNode, "Root Node.js engine and .nvmrc disagree.");
assert(rootPackage.engines?.npm === "11.19.0", "Root npm engine and packageManager disagree.");
const expectedAllowedScripts = {
  "electron-winstaller@5.4.0": true,
  "esbuild@0.28.2": true,
  koffi: true,
  "libxmljs2@0.37.0": true,
};
assert(JSON.stringify(rootPackage.allowScripts) === JSON.stringify(expectedAllowedScripts), "Reviewed install-script approvals have drifted.");
assert(readText(".npmrc").split(/\r?\n/).includes("strict-allow-scripts=true"), "Unreviewed dependency install scripts must fail closed.");
for (const workspacePackage of [desktopPackage, runtimePackage]) {
  assert(workspacePackage.private === true, `${workspacePackage.name} must remain private.`);
  assert(workspacePackage.engines?.node === requiredNode, `${workspacePackage.name} has drifted from the pinned Node.js version.`);
  assert(workspacePackage.version === rootPackage.version, `${workspacePackage.name} has drifted from the workspace version.`);
}

assert(packageLock.version === rootPackage.version, "package-lock.json root version is stale.");
for (const workspace of ["", "fivem-studio", "fivem-mcp-server"]) {
  assert(packageLock.packages?.[workspace]?.version === rootPackage.version, `package-lock.json version is stale for ${workspace || "the root"}.`);
}
assert(packageLock.packages?.[""]?.engines?.node === requiredNode, "package-lock.json does not contain the pinned Node.js engine.");
assert(packageLock.packages?.[""]?.engines?.npm === "11.19.0", "package-lock.json does not contain the pinned npm engine.");
assert(packageLock.packages?.["node_modules/dompurify"]?.version === "3.4.14", "The reviewed DOMPurify override is not locked.");
assert(desktopPackage.dependencies?.koffi === "3.1.6", "Koffi must remain exact because npm cannot pin its nested workspace install-script identity.");
assert(packageLock.packages?.["fivem-studio/node_modules/koffi"]?.version === "3.1.6", "The reviewed Koffi install script version is not locked.");
assert(desktopPackage.dependencies?.["electron-updater"] === "6.8.9", "electron-updater must remain pinned to the reviewed 6.8.9 release.");
assert(packageLock.packages?.["fivem-studio"]?.dependencies?.["electron-updater"] === "6.8.9", "The workspace lock metadata must pin electron-updater 6.8.9.");
assert(packageLock.packages?.["node_modules/electron-updater"]?.version === "6.8.9", "The installed electron-updater lock entry has drifted from 6.8.9.");

const expectedPublishConfig = [{ provider: "github", owner: "qbcore-framework", repo: "qb-studio" }];
assert(
  JSON.stringify(desktopPackage.build?.publish) === JSON.stringify(expectedPublishConfig),
  "The packaged updater must use the explicit official QB Studio GitHub provider configuration.",
);

const semanticRelease = readJson(".releaserc.json");
const githubReleasePlugin = semanticRelease.plugins?.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/github",
);
const expectedReleaseAssets = [
  { path: "release/QB-Studio-Setup-*.exe", label: "QB Studio Windows installer" },
  { path: "release/latest.yml", label: "QB Studio update manifest" },
  { path: "release/QB-Studio-Setup-*.exe.blockmap", label: "QB Studio Windows installer blockmap" },
];
assert(
  JSON.stringify(githubReleasePlugin?.[1]?.assets) === JSON.stringify(expectedReleaseAssets),
  "Semantic release must publish the exact installer, latest.yml, and versioned installer blockmap patterns.",
);

const gitignore = readText(".gitignore");
for (const nestedLock of ["fivem-studio/package-lock.json", "fivem-mcp-server/package-lock.json"]) {
  assert(gitignore.split(/\r?\n/).includes(nestedLock), `${nestedLock} must remain ignored in favor of the monorepo lockfile.`);
}

const desktopTests = desktopPackage.scripts?.test ?? "";
assert(desktopTests.includes('"dist-electron/**/*.test.js"'), "Desktop tests must use Node's cross-platform test discovery glob.");
assert((desktopTests.match(/\.test\.js/g) ?? []).length === 1, "Desktop tests must not return to a manually enumerated file list.");
assert(desktopPackage.scripts?.pretest?.includes("require('electron')"), "Desktop tests must prepare Electron once before parallel discovery.");
assert(desktopPackage.build?.files?.includes("!dist-electron/**/*.map"), "Desktop source maps must be excluded from the package.");
assert(desktopPackage.build?.files?.includes("!dist-electron/**/*.test.js"), "Desktop tests must be excluded from the package.");
assert(desktopPackage.build?.files?.includes("dist-electron/**/*"), "Compiled Electron workers must remain included in the package.");
assert(fs.existsSync(path.join(root, "fivem-studio", "electron", "workspaceSearchWorker.ts")), "The bounded workspace-search worker source is missing.");

const workflowsDir = path.join(root, ".github", "workflows");
for (const name of fs.readdirSync(workflowsDir).filter((entry) => /\.ya?ml$/i.test(entry))) {
  const workflow = fs.readFileSync(path.join(workflowsDir, name), "utf8");
  for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    const action = match[1];
    if (action.startsWith("./") || action.startsWith("docker://")) continue;
    assert(/^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/.test(action), `${name} does not pin ${action} to a full commit SHA.`);
  }
  if (workflow.includes("npm ci")) {
    assert(workflow.includes("npm run audit:dependencies"), `${name} must audit the complete locked dependency graph.`);
    assert(!workflow.includes("npm audit --omit=dev"), `${name} omits bundled renderer code from its dependency audit.`);
  }
}
const releaseWorkflow = readText(".github/workflows/release.yml");
assert(releaseWorkflow.includes('$installerPath = "release/QB-Studio-Setup-$version-x64.exe"'), "The release workflow must resolve the exact versioned installer.");
assert(releaseWorkflow.includes('$blockmapPath = "$installerPath.blockmap"'), "The release workflow must resolve the exact versioned installer blockmap.");
assert(releaseWorkflow.includes("Test-Path -LiteralPath release/latest.yml -PathType Leaf"), "The release workflow must require latest.yml before reporting a release.");

const releaseScript = readText("scripts/package-release.mjs");
assert(!releaseScript.includes('run(npm, ["install"'), "Release packaging must not re-resolve the reviewed lockfile.");
assert(!/\b(?:ComSpec|COMSPEC)\b/.test(releaseScript), "Release packaging must not select a command shell from the environment.");
assert(
  releaseScript.includes("spawnSync(process.execPath, [scriptPath, ...args]") && releaseScript.includes("shell: false"),
  "Release packaging must execute JavaScript CLIs directly with the pinned Node executable and no shell.",
);
for (const requiredDocument of ["BUILDING.md", "SECURITY.md", "DEPENDENCY_POLICY.md", "LOCALIZATION.md"]) {
  assert(fs.existsSync(path.join(root, requiredDocument)), `${requiredDocument} is missing.`);
}

console.log("Repository metadata, workflow pins, dependency gate, test discovery, and package exclusions are consistent.");
