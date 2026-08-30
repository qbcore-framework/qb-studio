import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyManifestDataFile,
  manifestDataFileDraftsAreComplete,
  manifestPresenceFlagIsActive,
  manifestPackfileCovers,
  manifestParserRangeReadsForTesting,
  normalizeManifestListDraft,
  parseManifestForm,
  REDM_MANIFEST_WARNING,
  updateManifestForm,
  validateManifestFormValues,
} from "./manifestModel";

test("manifest list drafts tolerate blank and in-progress lines", () => {
  assert.deepEqual(normalizeManifestListDraft("client/main.lua\n"), ["client/main.lua"]);
  assert.deepEqual(
    normalizeManifestListDraft("client/main.lua\n  \n server/main.lua "),
    ["client/main.lua", "server/main.lua"],
  );

  const source = "client_script 'client/main.lua'\n";
  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(updateManifestForm(source, {
    ...parsed.values,
    client_scripts: normalizeManifestListDraft("client/main.lua\n"),
  }), source);
});

test("manifest form parses common scalar, singular, and list directives", () => {
  const parsed = parseManifestForm(`fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client.lua'\ndependencies { 'qb-core', 'oxmysql' }\n`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.values.fx_version, "cerulean");
  assert.deepEqual(parsed.values.games, ["gta5"]);
  assert.deepEqual(parsed.values.client_scripts, ["client.lua"]);
  assert.deepEqual(parsed.values.dependencies, ["qb-core", "oxmysql"]);
});

test("manifest form parses official plural games, NUI, flags, exports, provides, and data files", () => {
  const parsed = parseManifestForm(`fx_version 'cerulean'
games { 'rdr3', 'gta5' }
rdr3_warning '${REDM_MANIFEST_WARNING}'
description 'Example resource'
ui_page 'html/index.html'
files { 'html/index.html', 'html/**/*' }
exports { 'openUi' }
server_export 'serverState'
provide 'legacy-name'
server_only 'yes'
node_version '22'
data_file 'HANDLING_FILE' 'metas/handling.meta'
`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.values.games, ["rdr3", "gta5"]);
  assert.equal(parsed.values.description, "Example resource");
  assert.equal(parsed.values.ui_page, "html/index.html");
  assert.deepEqual(parsed.values.exports, ["openUi"]);
  assert.deepEqual(parsed.values.server_exports, ["serverState"]);
  assert.deepEqual(parsed.values.provides, ["legacy-name"]);
  assert.equal(parsed.values.server_only, "yes");
  assert.equal(parsed.values.node_version, "22");
  assert.deepEqual(parsed.values.data_files, [{ type: "HANDLING_FILE", path: "metas/handling.meta" }]);
});

test("manifest form aggregates repeated singular games without appending conflicting metadata", () => {
  const source = "game 'gta5'\ngame 'rdr3'\nrdr3_warning 'legacy warning'\n";
  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.values.games, ["gta5", "rdr3"]);
  const updated = updateManifestForm(source, { ...parsed.values, description: "Updated" });
  assert.equal((updated.match(/^games?\b/gm) ?? []).length, 2);
  assert.match(updated, new RegExp(`^rdr3_warning '${REDM_MANIFEST_WARNING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"));
});

test("manifest form maintains the RedM warning when games change", () => {
  const source = "fx_version 'cerulean'\ngame 'gta5'\n";
  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const redm = updateManifestForm(source, { ...parsed.values, games: ["rdr3"] });
  assert.match(redm, /^games \{/m);
  assert.match(redm, new RegExp(`^rdr3_warning '${REDM_MANIFEST_WARNING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"));
  const reparsed = parseManifestForm(redm);
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  const gta = updateManifestForm(redm, { ...reparsed.values, games: ["gta5"] });
  assert.doesNotMatch(gta, /^rdr3_warning\b/m);
});

test("manifest form rejects incompatible common and game-specific API sets", () => {
  const parsed = parseManifestForm("games { 'common', 'gta5' }\n");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /cannot be combined/i);
});

test("manifest form changes modeled fields while preserving comments and unknown constructs", () => {
  const source = `-- heading\nfx_version 'cerulean' -- keep this\ncustom_directive SOME_VALUE\nclient_script 'old.lua'\n`;
  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const updated = updateManifestForm(source, { ...parsed.values, client_scripts: ["client/main.lua", "client/events.lua"] });
  assert.match(updated, /-- heading/);
  assert.match(updated, /-- keep this/);
  assert.match(updated, /custom_directive SOME_VALUE/);
  assert.match(updated, /client_scripts \{/);
  assert.match(updated, /client\/events\.lua/);
});

test("manifest form refuses dynamic modeled values instead of rewriting them", () => {
  const parsed = parseManifestForm("fx_version version_name\n");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /dynamic value/);
});

test("manifest form ignores directive-looking text inside Lua block comments and long strings", () => {
  const source = `--[[ documentation example
game 'rdr3'
server_script 'commented.lua'
]]
local example = [=[
client_script 'also-not-metadata.lua'
]=]
fx_version 'cerulean'
client_script 'real.lua'
`;
  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.values.games, []);
  assert.deepEqual(parsed.values.client_scripts, ["real.lua"]);
  assert.deepEqual(parsed.values.server_scripts, []);
  const updated = updateManifestForm(source, { ...parsed.values, description: "Block-safe" });
  assert.match(updated, /game 'rdr3'/);
  assert.match(updated, /server_script 'commented\.lua'/);
  assert.match(updated, /client_script 'also-not-metadata\.lua'/);
  assert.equal((updated.match(/^description\b/gm) ?? []).length, 1);
});

test("manifest form does not mistake double hyphens inside quoted metadata for comments", () => {
  const source = "description 'keeps -- literal text'\nfiles { 'html/a--b.js', -- keep asset\n  'html/c.js' }\n";
  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.values.description, "keeps -- literal text");
  assert.deepEqual(parsed.values.files, ["html/a--b.js", "html/c.js"]);
  const updated = updateManifestForm(source, {
    ...parsed.values,
    description: "changed",
    files: [...parsed.values.files, "html/d.js"],
  });
  assert.doesNotMatch(updated, /^-- literal text/m);
  assert.doesNotMatch(updated, /^--b\.js/m);
  assert.match(updated, /-- keep asset/);
  assert.match(updated, /files \{/);
});

test("manifest form preserves a multiline comment attached to modeled metadata", () => {
  const source = "fx_version 'cerulean' --[[ compatibility note\nkeep this block\n]]\ngame 'gta5'\n";
  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const updated = updateManifestForm(source, { ...parsed.values, fx_version: "bodacious" });
  assert.match(updated, /--\[\[ compatibility note\nkeep this block\n\]\]/);
  assert.equal((updated.match(/compatibility note/g) ?? []).length, 1);
  assert.match(updated, /^fx_version 'bodacious'$/m);
});

test("manifest comment lookup uses bounded indexed work on many directives", () => {
  const dependencyCount = 2_048;
  const source = "fx_version 'cerulean'\ngame 'gta5'\n" + Array.from(
    { length: dependencyCount },
    (_, index) => `dependency 'resource-${index}' -- preserve ${index}\n`,
  ).join("");

  const work = manifestParserRangeReadsForTesting(source);
  assert.equal(work.statementCount, dependencyCount + 2);
  assert.ok(
    work.inactiveRangeReads < dependencyCount * 120,
    `expected indexed inactive-range lookup, observed ${work.inactiveRangeReads} reads`,
  );

  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.values.dependencies.length, dependencyCount);
});

test("manifest form appends multiple new fields in deterministic model order", () => {
  const parsed = parseManifestForm("custom_directive 'preserved'\n");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const updated = updateManifestForm("custom_directive 'preserved'\n", {
    ...parsed.values,
    fx_version: "cerulean",
    description: "Example",
    ui_page: "html/index.html",
    games: ["gta5"],
    files: ["html/**/*"],
    data_files: [{ type: "HANDLING_FILE", path: "metas/handling.meta" }],
  });
  assert.ok(updated.indexOf("fx_version") < updated.indexOf("description"));
  assert.ok(updated.indexOf("description") < updated.indexOf("ui_page"));
  assert.ok(updated.indexOf("ui_page") < updated.indexOf("games"));
  assert.ok(updated.indexOf("games") < updated.indexOf("files"));
  assert.ok(updated.indexOf("files") < updated.indexOf("data_file"));
  assert.match(updated, /custom_directive 'preserved'/);
});

test("manifest form validation requires a supported FX version, a game, and covered local pages", () => {
  const parsed = parseManifestForm("custom_directive 'preserved'\n");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(validateManifestFormValues(parsed.values), ["fx_version", "games"]);

  const valid = {
    ...parsed.values,
    fx_version: "cerulean",
    games: ["gta5"],
    ui_page: "html/index.html",
    loadscreen: "https://example.invalid/loadscreen.html",
    files: ["html/**/*"],
  };
  assert.deepEqual(validateManifestFormValues(valid), []);
  assert.equal(manifestPackfileCovers(["html/dist/**/*"], "html/dist/index.html"), true);
  assert.equal(manifestPackfileCovers(["html/*.html"], "html/nested/index.html"), false);
  assert.deepEqual(validateManifestFormValues({ ...valid, files: [] }), ["ui_page_file"]);
  assert.deepEqual(validateManifestFormValues({ ...valid, fx_version: "future", games: [] }), ["fx_version", "games"]);
  assert.deepEqual(validateManifestFormValues({
    ...valid,
    data_files: [{ type: "HANDLING_FILE", path: "" }],
  }), ["data_files"]);
});

test("manifest presence flags treat every nonempty metadata value as active and canonically write yes", () => {
  assert.equal(manifestPresenceFlagIsActive("yes"), true);
  assert.equal(manifestPresenceFlagIsActive("false"), true);
  assert.equal(manifestPresenceFlagIsActive("custom-value"), true);
  assert.equal(manifestPresenceFlagIsActive("  "), false);
  assert.equal(manifestPresenceFlagIsActive(""), false);

  const source = "fx_version 'cerulean'\ngame 'gta5'\nserver_only 'false'\n";
  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const updated = updateManifestForm(source, { ...parsed.values, server_only: "yes" });
  assert.match(updated, /^server_only 'yes'$/m);
  assert.doesNotMatch(updated, /^server_only 'false'$/m);
});

test("new manifest data_file drafts require an intentional type and path", () => {
  const draft = createEmptyManifestDataFile();
  assert.deepEqual(draft, { type: "", path: "" });
  assert.notEqual(draft, createEmptyManifestDataFile());
  assert.equal(manifestDataFileDraftsAreComplete([]), true);
  assert.equal(manifestDataFileDraftsAreComplete([draft]), false);
  assert.equal(manifestDataFileDraftsAreComplete([{ type: "HANDLING_FILE", path: "" }]), false);
  assert.equal(manifestDataFileDraftsAreComplete([{ type: "", path: "handling.meta" }]), false);
  assert.equal(manifestDataFileDraftsAreComplete([{
    type: "HANDLING_FILE",
    path: "handling.meta",
  }]), true);
});

test("manifest form validation constrains node_version to the documented runtimes", () => {
  const parsed = parseManifestForm("fx_version 'cerulean'\ngame 'gta5'\n");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(validateManifestFormValues({ ...parsed.values, node_version: "" }), []);
  assert.deepEqual(validateManifestFormValues({ ...parsed.values, node_version: "16" }), []);
  assert.deepEqual(validateManifestFormValues({ ...parsed.values, node_version: "22" }), []);
  assert.deepEqual(validateManifestFormValues({ ...parsed.values, node_version: " 22 " }), []);
  assert.deepEqual(validateManifestFormValues({ ...parsed.values, node_version: "20" }), ["node_version"]);
});

test("manifest form validation requires replace_level_meta's implicit .meta file in the packfile", () => {
  const parsed = parseManifestForm("fx_version 'cerulean'\ngame 'gta5'\n");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const replacement = { ...parsed.values, replace_level_meta: "maps/mymap" };
  assert.deepEqual(validateManifestFormValues(replacement), ["replace_level_meta_file"]);
  assert.deepEqual(validateManifestFormValues({
    ...replacement,
    files: ["maps/mymap.meta"],
  }), []);
  assert.deepEqual(validateManifestFormValues({
    ...replacement,
    files: ["maps/*.meta"],
  }), []);
  assert.deepEqual(validateManifestFormValues({
    ...replacement,
    replace_level_meta: "maps/mymap.meta",
    files: ["maps/mymap.meta"],
  }), []);
  assert.deepEqual(validateManifestFormValues({
    ...replacement,
    files: ["maps/mymap"],
  }), ["replace_level_meta_file"]);
});

test("server_only validation rejects each client-delivered or client-runtime manifest field", () => {
  const parsed = parseManifestForm("fx_version 'cerulean'\ngame 'gta5'\n");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const serverOnly = { ...parsed.values, server_only: "false" };
  const conflicts: Array<[string, typeof serverOnly]> = [
    ["shared_scripts", { ...serverOnly, shared_scripts: ["shared.lua"] }],
    ["client_scripts", { ...serverOnly, client_scripts: ["client.lua"] }],
    ["exports", { ...serverOnly, exports: ["openUi"] }],
    ["files", { ...serverOnly, files: ["html/index.html"] }],
    ["ui_page", { ...serverOnly, ui_page: "https://example.invalid/index.html" }],
    ["loadscreen", { ...serverOnly, loadscreen: "https://example.invalid/loadscreen.html" }],
    ["replace_level_meta", {
      ...serverOnly,
      replace_level_meta: "maps/mymap",
      files: ["maps/mymap.meta"],
    }],
    ["this_is_a_map", { ...serverOnly, this_is_a_map: "enabled" }],
    ["loadscreen_manual_shutdown", { ...serverOnly, loadscreen_manual_shutdown: "yes" }],
    ["loadscreen_cursor", { ...serverOnly, loadscreen_cursor: "yes" }],
    ["data_files", {
      ...serverOnly,
      data_files: [{ type: "HANDLING_FILE", path: "handling.meta" }],
    }],
  ];
  for (const [field, values] of conflicts) {
    assert.deepEqual(validateManifestFormValues(values), ["server_only_conflict"], field);
  }
  assert.deepEqual(validateManifestFormValues({
    ...serverOnly,
    server_scripts: ["server.lua"],
    server_exports: ["getState"],
    node_version: "22",
    dependencies: ["oxmysql"],
    provides: ["legacy-server"],
  }), []);
});

test("packfile glob validation stays bounded on adversarial wildcard input", () => {
  const target = "a".repeat(60);
  const adversarial = `${"*a".repeat(7)}b`;
  const started = performance.now();
  assert.equal(manifestPackfileCovers([adversarial], target), false);
  assert.ok(performance.now() - started < 250, "adversarial glob validation exceeded its bounded work budget");
  assert.equal(manifestPackfileCovers(["*".repeat(100_000)], "a"), false);

  assert.equal(manifestPackfileCovers(["**/*.lua"], "main.lua"), true);
  assert.equal(manifestPackfileCovers(["html/**/index?.html"], "html/nested/pages/index1.html"), true);
  assert.equal(manifestPackfileCovers(["html/*.html"], "html/nested/index.html"), false);
});
