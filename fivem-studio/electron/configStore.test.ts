import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  connectionCredentialScope,
  connectionCredentialStorageName,
  credentialLoadPlan,
  DEFAULT_AGENT_CONNECTION_ID,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  legacyAgentConnectionId,
  legacyCredentialStoragePaths,
  MAX_AGENT_CONNECTIONS,
  MAX_CREDENTIAL_REVISION,
  MAX_MODELS_PER_CONNECTION,
  normalizeConfig,
  providerCredentialStorageAccess,
  providerCredentialStorageNames,
  type AgentConnection,
} from "./configStore";

function openAiConnection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "connection-one",
    label: "Provider one",
    provider: "openai",
    baseUrl: "https://api.example.com/v1",
    models: ["model-one"],
    requiresKey: true,
    ...overrides,
  };
}

test("fresh config has one active Gemini connection and no legacy flat fields", () => {
  const normalized = normalizeConfig({});
  assert.deepEqual(normalized.agent, {
    schemaVersion: 1,
    connections: [{
      id: DEFAULT_AGENT_CONNECTION_ID,
      label: "Google Gemini",
      provider: "openai",
      baseUrl: DEFAULT_GEMINI_BASE_URL,
      models: [DEFAULT_GEMINI_MODEL],
      requiresKey: true,
    }],
    active: { connectionId: DEFAULT_AGENT_CONNECTION_ID, model: DEFAULT_GEMINI_MODEL },
    credentialRevision: 0,
  });
  assert.equal("agentProvider" in normalized, false);
  assert.equal("openaiBaseUrl" in normalized, false);
  assert.equal("openaiModel" in normalized, false);
});

test("legacy OpenAI-compatible settings migrate deterministically without changing the selected model", () => {
  const rawUrl = "https://EXAMPLE.com:443/provider/../v1";
  const first = normalizeConfig({
    agentProvider: "openai",
    openaiBaseUrl: rawUrl,
    openaiModel: "vendor/model:latest",
  }).agent;
  const second = normalizeConfig({
    agentProvider: "openai",
    openaiBaseUrl: rawUrl,
    openaiModel: "vendor/model:latest",
  }).agent;
  const canonical = "https://example.com/v1";

  assert.deepEqual(first, second, "legacy ids must not change between normalization calls");
  assert.equal(first.connections[0].id, legacyAgentConnectionId("openai", canonical));
  assert.equal(first.connections[0].baseUrl, canonical);
  assert.deepEqual(first.connections[0].models, ["vendor/model:latest"]);
  assert.deepEqual(first.active, { connectionId: first.connections[0].id, model: "vendor/model:latest" });
  assert.equal(first.credentialRevision, 0);
  assert.equal(first.connections[0].requiresKey, false, "a legacy custom endpoint without storage evidence stays keyless");
});

test("legacy Anthropic settings migrate to the native endpoint and model", () => {
  const agent = normalizeConfig({
    agentProvider: "anthropic",
    openaiBaseUrl: "https://stale.example/v1",
    openaiModel: "stale-openai-model",
  }).agent;
  assert.deepEqual(agent.connections, [{
    id: legacyAgentConnectionId("anthropic", ""),
    label: "Anthropic",
    provider: "anthropic",
    baseUrl: "",
    models: ["claude-opus-5"],
    requiresKey: true,
  }]);
  assert.deepEqual(agent.active, { connectionId: agent.connections[0].id, model: "claude-opus-5" });
  assert.equal(agent.credentialRevision, 0);
});

test("versioned agent settings canonicalize connections and preserve safe active model changes", () => {
  const agent = normalizeConfig({
    agent: {
      schemaVersion: 1,
      credentialRevision: 42,
      connections: [
        openAiConnection({ baseUrl: "https://EXAMPLE.com:443/v1", models: ["old", "old", "bad\nmodel"] }),
        {
          id: "anthropic-work",
          label: "  Work Claude  ",
          provider: "anthropic",
          baseUrl: "https://renderer-controlled.example/v1",
          models: ["claude-opus-5"],
          requiresKey: false,
        },
        openAiConnection({
          id: "local",
          label: "Local",
          baseUrl: "http://127.0.0.1:11434/v1",
          models: ["qwen"],
          requiresKey: true,
        }),
      ],
      active: { connectionId: "connection-one", model: "new-model" },
    },
  }).agent;

  assert.equal(agent.credentialRevision, 42);
  assert.equal(agent.connections[0].baseUrl, "https://example.com/v1");
  assert.deepEqual(agent.connections[0].models, ["new-model", "old"]);
  assert.deepEqual(agent.active, { connectionId: "connection-one", model: "new-model" });
  assert.deepEqual(agent.connections[1], {
    id: "anthropic-work",
    label: "Work Claude",
    provider: "anthropic",
    baseUrl: "",
    models: ["claude-opus-5"],
    requiresKey: true,
  });
  assert.equal(agent.connections[2].requiresKey, true, "authenticated numeric-loopback endpoints remain supported");
});

test("known hosted preset endpoints cannot normalize into keyless connections", () => {
  const agent = normalizeConfig({
    agent: {
      schemaVersion: 1,
      connections: [openAiConnection({
        id: "gemini-pasted-as-custom",
        baseUrl: "https://GENERATIVELANGUAGE.googleapis.com:443/v1beta/other/../openai",
        requiresKey: false,
      })],
      active: { connectionId: "gemini-pasted-as-custom", model: "model-one" },
    },
  }).agent;

  assert.equal(agent.connections[0].baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(agent.connections[0].requiresKey, true);
});

test("connection and model lists are bounded and ids are unique", () => {
  const connections = Array.from({ length: MAX_AGENT_CONNECTIONS + 8 }, (_, index) => openAiConnection({
    id: `connection-${index}`,
    label: `Connection ${index}`,
    baseUrl: `https://provider-${index}.example/v1`,
    models: Array.from({ length: MAX_MODELS_PER_CONNECTION + 8 }, (_unused, model) => `model-${model}`),
  }));
  connections.splice(1, 0, openAiConnection({ id: "connection-0", label: "Duplicate should lose" }));
  const agent = normalizeConfig({
    agent: {
      schemaVersion: 1,
      connections,
      active: { connectionId: `connection-${MAX_AGENT_CONNECTIONS + 1}`, model: "outside-bound" },
    },
  }).agent;

  assert.equal(agent.connections.length, MAX_AGENT_CONNECTIONS);
  assert.equal(new Set(agent.connections.map((connection) => connection.id)).size, MAX_AGENT_CONNECTIONS);
  assert.equal(agent.connections[0].models.length, MAX_MODELS_PER_CONNECTION);
  assert.deepEqual(agent.active, { connectionId: "connection-0", model: "model-0" });
});

test("invalid connections are rejected without allowing unsafe ids, labels, or endpoints", () => {
  const sixtyFourCharacterId = "a".repeat(64);
  const agent = normalizeConfig({
    agent: {
      schemaVersion: 1,
      connections: [
        openAiConnection({ id: "../escape" }),
        openAiConnection({ id: "a".repeat(65) }),
        openAiConnection({ id: "bad-label", label: "line\nbreak" }),
        openAiConnection({ id: "bad-url", baseUrl: "http://api.example.com/v1" }),
        openAiConnection({ id: "embedded-key", baseUrl: "https://key@api.example.com/v1" }),
        openAiConnection({ id: sixtyFourCharacterId, label: "Accepted boundary" }),
      ],
      active: { connectionId: "missing", model: "ignored" },
    },
  }).agent;
  assert.deepEqual(agent.connections.map((connection) => connection.id), [sixtyFourCharacterId]);
  assert.deepEqual(agent.active, { connectionId: sixtyFourCharacterId, model: "model-one" });

  const allInvalid = normalizeConfig({
    agent: { schemaVersion: 1, connections: [openAiConnection({ id: "not valid" })], active: {} },
  }).agent;
  assert.equal(allInvalid.connections[0].id, DEFAULT_AGENT_CONNECTION_ID);
});

test("blank model ids never survive normalization or become the active target", () => {
  const seeded = normalizeConfig({
    agent: {
      schemaVersion: 1,
      connections: [
        openAiConnection({ id: "blank", models: ["", "   ", "bad\tmodel"] }),
        openAiConnection({ id: "seeded", models: [] }),
      ],
      active: { connectionId: "seeded", model: "selected-model" },
    },
  }).agent;
  assert.deepEqual(seeded.connections, [openAiConnection({ id: "seeded", models: ["selected-model"] })]);
  assert.deepEqual(seeded.active, { connectionId: "seeded", model: "selected-model" });

  const defaulted = normalizeConfig({
    agent: {
      schemaVersion: 1,
      connections: [openAiConnection({ models: ["", "  "] })],
      active: { connectionId: "connection-one", model: " \t " },
    },
  }).agent;
  assert.equal(defaulted.connections[0].id, DEFAULT_AGENT_CONNECTION_ID);
  assert.equal(defaulted.active.model, DEFAULT_GEMINI_MODEL);
});

test("model ids are whitespace-canonicalized before deduplication and active selection", () => {
  const agent = normalizeConfig({
    agent: {
      schemaVersion: 1,
      connections: [openAiConnection({ models: [" model-one ", "model-one", " model-two "] })],
      active: { connectionId: "connection-one", model: " model-two " },
    },
  }).agent;

  assert.deepEqual(agent.connections[0].models, ["model-one", "model-two"]);
  assert.deepEqual(agent.active, { connectionId: "connection-one", model: "model-two" });

  const legacy = normalizeConfig({
    agentProvider: "openai",
    openaiBaseUrl: "https://api.example.com/v1",
    openaiModel: " legacy-model ",
  }).agent;
  assert.deepEqual(legacy.connections[0].models, ["legacy-model"]);
  assert.equal(legacy.active.model, "legacy-model");
});

test("credential revision accepts only bounded nonnegative integers", () => {
  const withRevision = (credentialRevision: unknown) => normalizeConfig({
    agent: {
      schemaVersion: 1,
      credentialRevision,
      connections: [openAiConnection()],
      active: { connectionId: "connection-one", model: "model-one" },
    },
  }).agent.credentialRevision;
  assert.equal(withRevision(0), 0);
  assert.equal(withRevision(MAX_CREDENTIAL_REVISION), MAX_CREDENTIAL_REVISION);
  for (const invalid of [-1, 1.5, MAX_CREDENTIAL_REVISION + 1, "2", Number.NaN]) {
    assert.equal(withRevision(invalid), 0);
  }
});

test("connection credential scope isolates accounts and endpoint edits but ignores labels, models, and key policy", () => {
  const first = openAiConnection();
  const equivalentUrl = openAiConnection({ baseUrl: "https://API.example.com:443/v1" });
  const anotherAccount = openAiConnection({ id: "connection-two" });
  const anotherEndpoint = openAiConnection({ baseUrl: "https://api.example.com/v2" });
  const renamedAndRemodeled = openAiConnection({
    label: "Renamed",
    models: ["different-model"],
    requiresKey: false,
  });

  assert.equal(connectionCredentialScope(first), connectionCredentialScope(equivalentUrl));
  assert.equal(connectionCredentialStorageName(first), connectionCredentialStorageName(equivalentUrl));
  assert.notEqual(connectionCredentialStorageName(first), connectionCredentialStorageName(anotherAccount));
  assert.notEqual(connectionCredentialStorageName(first), connectionCredentialStorageName(anotherEndpoint));
  assert.equal(connectionCredentialStorageName(first), connectionCredentialStorageName(renamedAndRemodeled));
  assert.match(connectionCredentialStorageName(first), /^agent-connection-[a-f0-9]{64}$/);
});

test("provider credential filenames hash the complete canonical endpoint and retain the legacy migration name", () => {
  const sharedPrefix = `https://example.com/${"a".repeat(100)}`;
  const first = providerCredentialStorageNames(`${sharedPrefix}/provider-one/v1`);
  const second = providerCredentialStorageNames(`${sharedPrefix}/provider-two/v1`);
  assert.match(first.current, /^provider-[a-f0-9]{64}$/);
  assert.notEqual(first.current, second.current, "full URLs that collided under the truncated slug must stay distinct");
  assert.equal(first.legacy, second.legacy, "fixture exercises the legacy truncated-slug collision");

  assert.equal(
    providerCredentialStorageNames("https://EXAMPLE.com:443/v1").current,
    providerCredentialStorageNames("https://example.com/v1").current,
    "URL canonicalization must not fork storage for equivalent endpoints",
  );
});

test("legacy provider keys are available only to the persisted endpoint, never a colliding draft", () => {
  const sharedPrefix = `https://example.com/${"a".repeat(100)}`;
  const persisted = `${sharedPrefix}/provider-one/v1`;
  const draft = `${sharedPrefix}/provider-two/v1`;
  const persistedNames = providerCredentialStorageNames(persisted);
  const draftNames = providerCredentialStorageNames(draft);
  assert.equal(persistedNames.legacy, draftNames.legacy, "fixture must collide under the legacy slug");

  assert.deepEqual(providerCredentialStorageAccess(persisted, persisted), {
    current: persistedNames.current,
    legacy: persistedNames.legacy,
  });
  assert.deepEqual(providerCredentialStorageAccess(draft, persisted), {
    current: draftNames.current,
    legacy: null,
  }, "a draft endpoint may neither migrate nor clear the persisted endpoint's legacy key");
});

test("canonical-equivalent provider URLs retain current-endpoint migration and clear access", () => {
  const access = providerCredentialStorageAccess(
    "https://EXAMPLE.com:443/v1",
    "https://example.com/v1",
  );
  const names = providerCredentialStorageNames("https://example.com/v1");
  assert.deepEqual(access, { current: names.current, legacy: names.legacy });
});

test("legacy credential aliases are owned only by the winning config directory", () => {
  const sharedPrefix = `https://example.com/${"a".repeat(100)}`;
  const connection = openAiConnection({ baseUrl: `${sharedPrefix}/provider-one/v1` });
  const colliding = openAiConnection({ baseUrl: `${sharedPrefix}/provider-two/v1` });
  const ownerDirectory = path.resolve("credential-fixtures", "winning-product");
  const unrelatedDirectory = path.resolve("credential-fixtures", "unrelated-product");
  const persistedConfigPath = path.join(ownerDirectory, "ghz-workbench.config.json");
  const ownedPaths = legacyCredentialStoragePaths(connection, persistedConfigPath);
  const connectionNames = providerCredentialStorageNames(connection.baseUrl);
  const collidingNames = providerCredentialStorageNames(colliding.baseUrl);

  assert.equal(connectionNames.legacy, collidingNames.legacy, "fixture must collide under the old slug");
  assert.deepEqual(ownedPaths, [
    path.join(ownerDirectory, `${connectionNames.current}-key.bin`),
    path.join(ownerDirectory, `${connectionNames.legacy}-key.bin`),
  ]);
  assert.ok(ownedPaths.every((candidate) => path.dirname(candidate) === ownerDirectory));
  assert.ok(!ownedPaths.includes(path.join(unrelatedDirectory, `${collidingNames.legacy}-key.bin`)));

  const withSafeHistoricalHash = legacyCredentialStoragePaths(connection, persistedConfigPath, [unrelatedDirectory]);
  assert.ok(withSafeHistoricalHash.includes(path.join(unrelatedDirectory, `${connectionNames.current}-key.bin`)));
  assert.ok(
    !withSafeHistoricalHash.includes(path.join(unrelatedDirectory, `${connectionNames.legacy}-key.bin`)),
    "the complete endpoint hash may migrate across former product directories, but the colliding slug may not",
  );
});

test("legacy Anthropic keys remain discoverable in known former product directories", () => {
  const ownerDirectory = path.resolve("credential-fixtures", "winning-product");
  const formerProductDirectory = path.resolve("credential-fixtures", "former-product");
  const persistedConfigPath = path.join(ownerDirectory, "ghz-workbench.config.json");
  const connection: AgentConnection = {
    id: "anthropic-default",
    label: "Anthropic",
    provider: "anthropic",
    baseUrl: "",
    models: ["claude-opus-5"],
    requiresKey: true,
  };

  assert.deepEqual(
    legacyCredentialStoragePaths(connection, persistedConfigPath, [formerProductDirectory]),
    [
      path.join(ownerDirectory, "anthropic-key.bin"),
      path.join(formerProductDirectory, "anthropic-key.bin"),
    ],
  );
});

test("raw-config-owned credentials precede stale scoped migration targets", () => {
  const ownedHashed = path.resolve("credentials", "provider-hash-key.bin");
  const ownedSlug = path.resolve("credentials", "provider-slug-key.bin");
  const staleScoped = path.resolve("current-product", "agent-connection-hash-key.bin");
  const duplicateScoped = path.resolve("old-product", "agent-connection-hash-key.bin");
  const existing = new Set([ownedHashed, ownedSlug, staleScoped, duplicateScoped]);

  assert.deepEqual(
    credentialLoadPlan(
      staleScoped,
      [staleScoped, duplicateScoped, ownedSlug],
      [ownedHashed, ownedSlug],
      (candidate) => existing.has(candidate),
    ),
    {
      candidates: [ownedHashed, ownedSlug],
      retireAfterMigration: [ownedHashed, ownedSlug],
    },
  );
});

test("an existing current scoped credential never falls through to a historical copy", () => {
  const current = path.resolve("current-product", "agent-connection-hash-key.bin");
  const historical = path.resolve("old-product", "agent-connection-hash-key.bin");
  const existing = new Set([current, historical]);

  assert.deepEqual(
    credentialLoadPlan(current, [current, historical], [], (candidate) => existing.has(candidate)),
    { candidates: [current], retireAfterMigration: [] },
  );
});

test("historical scoped credential migration retires every obsolete copy", () => {
  const current = path.resolve("current-product", "agent-connection-hash-key.bin");
  const firstHistorical = path.resolve("old-product-a", "agent-connection-hash-key.bin");
  const secondHistorical = path.resolve("old-product-b", "agent-connection-hash-key.bin");
  const existing = new Set([firstHistorical, secondHistorical]);

  assert.deepEqual(
    credentialLoadPlan(
      current,
      [current, firstHistorical, secondHistorical],
      [],
      (candidate) => existing.has(candidate),
    ),
    {
      candidates: [firstHistorical, secondHistorical],
      retireAfterMigration: [firstHistorical, secondHistorical],
    },
  );
});

test("single-path Enhanced settings migrate into the Enhanced slots", () => {
  const server = path.resolve("old-enhanced", "cfx-server.exe");
  const client = path.resolve("old-enhanced-client", "FiveM.exe");
  const migrated = normalizeConfig({ fxServerExePath: server, fivemExePath: client, artifactTrack: "latest" });

  assert.equal(migrated.activeCfxTarget, "enhanced");
  assert.equal(migrated.enhancedFxServerExePath, server);
  assert.equal(migrated.enhancedFivemExePath, client);
  assert.equal(migrated.legacyFxServerExePath, null);
  assert.equal(migrated.legacyFivemExePath, null);
  assert.equal(migrated.legacyArtifactTrack, "latest");
});

test("v1.1.5 active edition migrates to the matching Cfx target", () => {
  const migrated = normalizeConfig({ activeCfxEdition: "enhanced" });
  assert.equal(migrated.activeCfxTarget, "enhanced");
});

test("theme preferences migrate to system and accept every supported explicit theme", () => {
  assert.equal(normalizeConfig({}).theme, "system");
  for (const theme of ["system", "dark", "light", "high-contrast"] as const) {
    assert.equal(normalizeConfig({ theme }).theme, theme);
  }
  assert.equal(normalizeConfig({ theme: "custom:qb-red" }).theme, "custom:qb-red");
  assert.equal(normalizeConfig({ theme: "custom:../escape" }).theme, "system");
  assert.equal(normalizeConfig({ theme: "neon" }).theme, "system");
});

test("UI scale is bounded to supported zoom factors", () => {
  assert.equal(normalizeConfig({}).uiScale, 1);
  for (const uiScale of [0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
    assert.equal(normalizeConfig({ uiScale }).uiScale, uiScale);
  }
  assert.equal(normalizeConfig({ uiScale: 4 }).uiScale, 1);
});

test("explicit FiveM and RedM paths remain separate", () => {
  const legacyServer = path.resolve("legacy", "FXServer.exe");
  const enhancedServer = path.resolve("enhanced", "cfx-server.exe");
  const redmServer = path.resolve("redm", "FXServer.exe");
  const legacyClient = path.resolve("legacy-client", "FiveM.exe");
  const enhancedClient = path.resolve("enhanced-client", "FiveM.exe");
  const redmClient = path.resolve("redm-client", "RedM.exe");
  const normalized = normalizeConfig({
    activeCfxTarget: "redm",
    legacyFxServerExePath: legacyServer,
    enhancedFxServerExePath: enhancedServer,
    redmFxServerExePath: redmServer,
    legacyFivemExePath: legacyClient,
    enhancedFivemExePath: enhancedClient,
    redmClientExePath: redmClient,
    redmArtifactTrack: "latest",
  });

  assert.equal(normalized.activeCfxTarget, "redm");
  assert.equal(normalized.legacyFxServerExePath, legacyServer);
  assert.equal(normalized.enhancedFxServerExePath, enhancedServer);
  assert.equal(normalized.redmFxServerExePath, redmServer);
  assert.equal(normalized.legacyFivemExePath, legacyClient);
  assert.equal(normalized.enhancedFivemExePath, enhancedClient);
  assert.equal(normalized.redmClientExePath, redmClient);
  assert.equal(normalized.redmArtifactTrack, "latest");
});

test("console refresh accepts supported intervals and defaults invalid values", () => {
  for (const interval of [0, 1_000, 2_000, 5_000, 10_000, 30_000]) {
    assert.equal(normalizeConfig({ consoleRefreshIntervalMs: interval }).consoleRefreshIntervalMs, interval);
  }

  for (const interval of [-1, 500, 2_500, 60_000, "2000", null]) {
    assert.equal(normalizeConfig({ consoleRefreshIntervalMs: interval }).consoleRefreshIntervalMs, 2_000);
  }
});

test("unexpected server-exit notifications default on and accept an explicit preference", () => {
  assert.equal(normalizeConfig({}).notifyOnServerExit, true);
  assert.equal(normalizeConfig({ notifyOnServerExit: false }).notifyOnServerExit, false);
  assert.equal(normalizeConfig({ notifyOnServerExit: "false" }).notifyOnServerExit, true);
});

test("privacy-safe Discord presence defaults on and accepts an explicit preference", () => {
  assert.equal(normalizeConfig({}).discordPresenceEnabled, false);
  assert.equal(normalizeConfig({ discordPresenceEnabled: false }).discordPresenceEnabled, false);
  assert.equal(normalizeConfig({ discordPresenceEnabled: "false" }).discordPresenceEnabled, false);
});

test("agent spend warnings are configurable and bounded", () => {
  assert.equal(normalizeConfig({}).agentSpendWarningUsd, 5);
  for (const threshold of [0, 1, 2, 5, 10, 20]) {
    assert.equal(normalizeConfig({ agentSpendWarningUsd: threshold }).agentSpendWarningUsd, threshold);
  }
  assert.equal(normalizeConfig({ agentSpendWarningUsd: -1 }).agentSpendWarningUsd, 5);
});

test("editor preferences are bounded and migrate from missing settings", () => {
  assert.deepEqual(normalizeConfig({}).editor, {
    fontSize: 13,
    wordWrap: false,
    minimap: false,
    stickyScroll: true,
    formatOnSave: false,
    restartResourceOnSave: false,
    luaIntelligence: "balanced",
  });
  assert.deepEqual(normalizeConfig({
    editor: {
      fontSize: 18,
      wordWrap: true,
      minimap: true,
      stickyScroll: false,
      formatOnSave: true,
      restartResourceOnSave: true,
      luaIntelligence: "full",
    },
  }).editor, {
    fontSize: 18,
    wordWrap: true,
    minimap: true,
    stickyScroll: false,
    formatOnSave: true,
    restartResourceOnSave: true,
    luaIntelligence: "full",
  });
  assert.equal(normalizeConfig({ editor: { fontSize: 99 } }).editor.fontSize, 13);
  assert.equal(normalizeConfig({ editor: { luaIntelligence: "turbo" } }).editor.luaIntelligence, "balanced");
});
