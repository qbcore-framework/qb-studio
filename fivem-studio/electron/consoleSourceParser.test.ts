import assert from "node:assert/strict";
import test from "node:test";

import { parseConsoleSourceLocations } from "./consoleSourceParser";

function only(line: string) {
  const locations = parseConsoleSourceLocations(line);
  assert.equal(locations.length, 1, `expected one source location in: ${line}`);
  return locations[0];
}

test("parses real txAdmin script loading diagnostics and clamps column zero", () => {
  const line = "[12:00:00] [error] [yarn] Error loading script yarn_builder.js in resource yarn at line 81, column 0: unexpected token";
  const location = only(line);
  assert.deepEqual(
    { kind: location.kind, source: location.source, resourceName: location.resourceName, line: location.line, column: location.column },
    { kind: "relative", source: "yarn_builder.js", resourceName: "yarn", line: 81, column: 1 },
  );
  assert.equal(line.slice(location.start, location.end), "yarn_builder.js");
});

test("parses Lua and JavaScript Cfx resource frames with exact display ranges", () => {
  const lua = "[script:qb-weapons] SCRIPT ERROR: @qb-weapons/server/main.lua:166: attempt to index a nil value";
  const luaLocation = only(lua);
  assert.deepEqual(
    { kind: luaLocation.kind, source: luaLocation.source, resourceName: luaLocation.resourceName, line: luaLocation.line, column: luaLocation.column },
    { kind: "resource", source: "server/main.lua", resourceName: "qb-weapons", line: 166, column: 1 },
  );
  assert.equal(lua.slice(luaLocation.start, luaLocation.end), "@qb-weapons/server/main.lua:166");

  const js = "[script:ssl] at verify (@ssl/server/crypto.js:26:20)";
  const jsLocation = only(js);
  assert.equal(jsLocation.source, "server/crypto.js");
  assert.equal(jsLocation.line, 26);
  assert.equal(jsLocation.column, 20);
  assert.equal(js.slice(jsLocation.start, jsLocation.end), "@ssl/server/crypto.js:26:20");
});

test("parses a FiveM client-log error and preserves its client source path", () => {
  const line = "[     42000] [ citizen-scripting-lua] MainThrd/ SCRIPT ERROR: @demo/client/main.lua:73: attempt to index a nil value";
  const location = only(line);
  assert.deepEqual(
    { kind: location.kind, source: location.source, resourceName: location.resourceName, line: location.line, column: location.column },
    { kind: "resource", source: "client/main.lua", resourceName: "demo", line: 73, column: 1 },
  );
  assert.equal(line.slice(location.start, location.end), "@demo/client/main.lua:73");
});

test("parses colored Cfx frames without losing raw offsets", () => {
  const line = "^3> fn^7 (^5@custom_core/client/function.lua^7:199)";
  const location = only(line);
  assert.equal(location.source, "client/function.lua");
  assert.equal(location.line, 199);
  assert.equal(line.slice(location.start, location.end), "@custom_core/client/function.lua^7:199");
});

test("uses the script prefix for resource-relative and source-map frames", () => {
  const bare = only("[script:demo] index.js:5");
  assert.deepEqual(
    { kind: bare.kind, source: bare.source, resourceName: bare.resourceName, line: bare.line, column: bare.column },
    { kind: "relative", source: "index.js", resourceName: "demo", line: 5, column: 1 },
  );

  const ordinary = only("[script:phone] at handler (server/index.js:88:17)");
  assert.deepEqual(
    { kind: ordinary.kind, source: ordinary.source, resourceName: ordinary.resourceName, line: ordinary.line, column: ordinary.column },
    { kind: "relative", source: "server/index.js", resourceName: "phone", line: 88, column: 17 },
  );

  const sourceMap = only("[script:phone] > throw_a_error_plz (../server/index.ts:3)");
  assert.equal(sourceMap.source, "../server/index.ts");
  assert.equal(sourceMap.resourceName, "phone");
});

test("uses bracketed and bare Cfx resource prefixes for manifest warnings", () => {
  for (const prefix of ["[resource:demo]", "[resources:demo]", "resource:demo", "resources:demo"]) {
    const location = only(`${prefix} Warning: unsupported entry (defined in fxmanifest.lua:4)`);
    assert.deepEqual(
      { kind: location.kind, source: location.source, resourceName: location.resourceName, line: location.line, column: location.column },
      { kind: "relative", source: "fxmanifest.lua", resourceName: "demo", line: 4, column: 1 },
    );
  }
});

test("parses contained-style Windows and compiler locations with spaces", () => {
  const stack = only("at Example.Run () in D:\\txData\\My Profile\\resources\\[local]\\demo\\Server Main.cs:72");
  assert.equal(stack.kind, "absolute");
  assert.equal(stack.source, "D:\\txData\\My Profile\\resources\\[local]\\demo\\Server Main.cs");
  assert.equal(stack.line, 72);

  const modern = only("at Example.Run() in D:\\txData\\My Profile\\resources\\demo\\Main.cs:line 42");
  assert.equal(modern.line, 42);
  assert.equal(modern.column, 1);

  const compiler = only("D:\\txData\\My Profile\\resources\\demo\\Main.cs(12, 7): warning CS0219");
  assert.equal(compiler.line, 12);
  assert.equal(compiler.column, 7);
});

test("parses UNC absolute paths in stack and compiler locations", () => {
  const stackLine = "at Example.Run () in \\\\build-server\\txData\\My Profile\\resources\\demo\\Server Main.cs:72:5";
  const stack = only(stackLine);
  assert.deepEqual(
    { kind: stack.kind, source: stack.source, line: stack.line, column: stack.column },
    { kind: "absolute", source: "\\\\build-server\\txData\\My Profile\\resources\\demo\\Server Main.cs", line: 72, column: 5 },
  );
  assert.equal(stackLine.slice(stack.start, stack.end), "\\\\build-server\\txData\\My Profile\\resources\\demo\\Server Main.cs:72:5");

  const compiler = only("//build-server/txData/My Profile/resources/demo/Server Main.cs(12, 7): warning CS0219");
  assert.equal(compiler.kind, "absolute");
  assert.equal(compiler.source, "//build-server/txData/My Profile/resources/demo/Server Main.cs");
  assert.equal(compiler.line, 12);
  assert.equal(compiler.column, 7);
});

test("parses complete relative paths containing spaces instead of linking a suffix", () => {
  const stackLine = "[script:phone] at handler (server/feature flags/My Handler.ts:88:17)";
  const stack = only(stackLine);
  assert.deepEqual(
    { kind: stack.kind, source: stack.source, resourceName: stack.resourceName, line: stack.line, column: stack.column },
    { kind: "relative", source: "server/feature flags/My Handler.ts", resourceName: "phone", line: 88, column: 17 },
  );
  assert.equal(stackLine.slice(stack.start, stack.end), "server/feature flags/My Handler.ts:88:17");

  const quoted = only("[script:phone] failed in 'client/My Worker.js:29:4'");
  assert.equal(quoted.source, "client/My Worker.js");
  assert.equal(quoted.line, 29);
  assert.equal(quoted.column, 4);
});

test("parses profile paths, virtual resource paths, ANSI, and multiple locations", () => {
  const profile = only("warning at resources/[local]/demo/server/main.lua:12:3");
  assert.equal(profile.kind, "profile");
  assert.equal(profile.line, 12);
  assert.equal(profile.column, 3);

  const virtual = only("SCRIPT ERROR: resource:/demo/server/main.lua:9");
  assert.equal(virtual.kind, "resource");
  assert.equal(virtual.resourceName, "demo");

  const ansi = only("\u001b[31m@demo/server/main.lua:8:2\u001b[0m failed");
  assert.equal(ansi.source, "server/main.lua");

  const multipleLine = "[script:demo] @demo/a.lua:2 called @demo/b.js:4:6";
  const multiple = parseConsoleSourceLocations(multipleLine);
  assert.equal(multiple.length, 2);
  assert.deepEqual(multiple.map((location) => location.source), ["a.lua", "b.js"]);
});

test("does not link runtime internals, URLs, prose, invalid coordinates, or traversal", () => {
  const rejected = [
    "citizen:/scripting/lua/scheduler.lua:157: runtime failure",
    "at node:internal/crypto/keys:615:12",
    "https://example.com/app.js:42",
    "webpack://demo/src/index.ts:5:2",
    "connected to 127.0.0.1:30120",
    "release bundle app.js:42 is available",
    "[script:demo] at release bundle app.js:42",
    "[script:demo] @demo/server.lua:0",
    "[script:demo] @demo/../outside.lua:3",
    "[script:demo] @demo/server.lua:999999999",
  ];
  for (const line of rejected) assert.deepEqual(parseConsoleSourceLocations(line), [], line);
});

test("rejects NTFS alternate data stream colons while retaining the drive prefix", () => {
  const drive = only("at Example.Run () in D:\\txData\\resources\\demo\\Main.cs:42:3");
  assert.equal(drive.source, "D:\\txData\\resources\\demo\\Main.cs");

  const rejected = [
    "[script:demo] at D:\\txData\\resources\\demo\\Main.cs:payload:42",
    "[script:demo] at D:\\txData\\resources\\demo\\Main.cs:payload.lua:42",
    "at \\\\build-server\\share\\Main.cs:payload:42",
    "Error loading script server/main.lua:payload.lua in resource demo at line 9, column 2",
  ];
  for (const line of rejected) assert.deepEqual(parseConsoleSourceLocations(line), [], line);
});
