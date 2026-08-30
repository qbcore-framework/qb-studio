# QB Studio audit and improvement plan

## Product boundary

QB Studio is a single-user, localhost-only coding environment. Its live
runtime surface is intentionally limited to console reading and named resource
lifecycle actions. The embedded local-client preview is passive: it does not
add player or gameplay controls.

## Fixed in this stabilization pass

- Enforced numeric loopback-only MCP and RCON destinations without DNS
  resolution. Standard Cfx.re wildcard bind directives are normalized to
  loopback for RCON; explicit LAN/public targets remain rejected. QB Studio's
  generated local profile binds to `127.0.0.1` and disables advertisement.
- Removed all player, entity, teleport, spawn, screenshot, arbitrary-eval, and
  raw-RCON tools from the UI, agent allowlists, and bundled runtime.
- Added bounded requests/sessions, strict tool schemas, resource-name checks,
  workspace/runtime identity matching, and explicit approval for mutations.
- Scoped renderer file access to the selected workspace with traversal and
  symlink defenses, atomic writes, revision conflicts, trash deletion, and
  unsaved-change guards.
- Corrected the txAdmin model: a `*.base` server-data workspace is distinct
  from txAdmin's version-owned control profile. Creation is atomic and writes
  only `server.cfg`, `resources/[local]`, `.gitignore`, and a secrets example.
- Removed the obsolete in-server bridge entirely. First-run documentation and
  Settings now show the exact `set rcon_password`/secrets include, txAdmin
  attachment, server start, and rescan steps; no server resource is required.
- Discover txAdmin attachment through the control profile's `server.dataPath`;
  fresh workspaces no longer masquerade as control profiles, and console
  capability stays off until an unambiguous attachment exists.
- Bundled the coding runtime inside the Windows app. Each launch uses an
  ephemeral loopback port and fresh in-memory bearer token.
- Recursively validate bounded `exec` includes before accepting a profile as
  localhost-only, and isolate runtime launch generations so stale child events
  cannot terminate a newer workspace runtime.
- Use short-lived opaque IDs for local-client preview candidates and revalidate
  window ownership before native reparenting operations.
- Added workspace search/replace with bounded previews and revision checks,
  resource import/duplication staging, console filtering and crash triage, and
  demand-driven Lua language-server integration.
- Added an NSIS installer, CI, semantic versioning, coordinated installer,
  `latest.yml`, and blockmap release assets, GitHub build and complete-lockfile
  SBOM attestations, an MIT license, and QB Studio branding.
- Added user-controlled application updates: installed releases check the
  official GitHub feed at startup, download only after an explicit user action,
  and install only through **Restart to update**. Unsaved editor changes block
  that restart, and the current version remains visible in the top bar and
  **About & updates**.
- Hardened release qualification with exact Node/npm pins, immutable GitHub
  Action SHAs, complete moderate-threshold dependency auditing, least-privilege
  workflow jobs, cross-platform desktop test discovery, and package-content
  invariants.

## Next priorities

### P0 — before promoting beyond an early preview

1. Run an end-to-end matrix against a fresh generated workspace: txAdmin
   attachment, FXServer start, console tail, resource list, each lifecycle
   action, reconnect, app restart, and clean uninstall.
2. Add Authenticode signing, place the exact certificate subject in updater
   `publisherName`, and verify the complete installer/update trust chain.
3. Add a release smoke test that installs N-1 in a clean Windows VM, updates it
   to N through **Restart to update**, verifies the displayed and registered
   version, and tests both the default and a custom per-user install path.

### P1 — highest-value product improvements

1. Finish the Git workflow needed to replace GitHub Desktop: status, diff,
   stage, conventional commit, branch, pull, and push with clear confirmations.
2. Stream and filter console output instead of requiring manual refresh, with
   backpressure and a fixed memory cap.
3. Add a diagnostics page for txAdmin attachment, missing license/RCON config,
   port collisions, FXServer state, and actionable fixes.
4. Add first-class resource creation templates and extend manifest validation
   beyond the current safe import, duplicate, and form-editing workflows.
5. Add source-control-aware rename previews.

### P2 — polish

1. Add a distinctive signed app icon and a small onboarding walkthrough.
2. Add an exportable diagnostics bundle with an explicit redaction preview,
   building on the current local crash triage.
3. Add configurable lint profiles alongside the existing Lua language-server
   diagnostics and formatting.

## Known constraints

- The AI provider may receive prompts and selected project content; a local
  OpenAI-compatible provider is available for developers who require offline
  inference.
- txAdmin owns its control-profile schema. QB Studio creates a safe
  server-data workspace, then the developer attaches it through txAdmin's
  supported setup/deployer flow.
- Current installers and application updates are unsigned. GitHub HTTPS
  transport and the SHA-512 digest in `latest.yml` provide integrity within the
  GitHub release channel, but no independent Windows publisher identity;
  Authenticode and updater `publisherName` enforcement remain the priority
  trust upgrade.
- Semantic-release publishes before the separate least-privilege GitHub
  attestation job can run. A release is not considered attested until that job
  succeeds; publication and attestation are not atomic under the current
  workflow integration.
