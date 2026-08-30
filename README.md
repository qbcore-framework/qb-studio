# QB Studio

QB Studio is QBCore Framework's Windows desktop workspace for coding resources
against your own localhost Cfx.re server. It puts the editor, resource tree,
console, GitHub imports, AI coding assistant, and an optional passive
local-client preview in one app.

It is a development tool—not a server administration or gameplay tool. Its
control traffic never leaves numeric loopback, and it does not expose player
actions, raw RCON, arbitrary Lua execution, spawning, teleporting, or
screenshots.

## Highlights

- Monaco code editor with persistent per-file undo history, SQL/XML support, configurable editor preferences, Problems view, and safe change review before approved agent writes
- QBCore, FiveM, and RedM Lua intelligence powered by a bundled, verified Lua language server
- txData workspace browser with direct file/folder creation and Lua, static NUI, React, and Vue starter resources
- Separate one-click launchers and paths for FiveM Legacy, FiveM Enhanced, and RedM
- Bounded Auto detection for all three client launchers and server artifacts, with Browse for custom locations
- Recommended/Latest server-artifact updates with staging and rollback backup
- Read-only console with clickable source locations and scoped Agent Fix handoff, foreground-only configurable auto-refresh, synchronized non-destructive Clear view, and approved resource refresh controls for coding loops
- Opt-in, privacy-limited Discord Rich Presence that can be enabled in Settings
- Built-in themes plus validated user JSON theme packs with instant Settings preview
- GitHub repository and organization search with resource imports
- AI assistant scoped to project files and coding-oriented runtime tools, with saved provider accounts and an in-chat model switcher
- Bundled private runtime: no separate Node or MCP server to launch
- User-controlled application updates with download progress and an explicit **Restart to update** step

GitHub imports require [Git for Windows](https://git-scm.com/download/win).

## Install

Download the latest Windows installer from
[Releases](https://github.com/qbcore-framework/qb-studio/releases) and run it once.
Choose the `.exe`; GitHub automatically adds source-code ZIP and TAR archives,
but they are not installers.
After an updater-enabled release is installed, normal updates can be checked,
downloaded, and applied from **Settings → About & updates** without manually
visiting the Releases page.
QB Studio does not require any resource to be added to your server. Point
it at an existing Cfx.re Windows server artifact and it can start that local
server, launch the selected FiveM or RedM client separately, and update the artifact files.

## First run

You need an existing local FXServer installation with txAdmin, its `txData`
folder, and a Cfx.re server license key.

### Use an existing local workspace

1. Confirm the editable server-data folder is a direct child of `txData`,
   normally `txData\YourServer.base`, and contains `server.cfg` and
   `resources\`.
2. Leave the existing `endpoint_add_tcp` and `endpoint_add_udp` lines alone.
   QB Studio reads their port; the standard `0.0.0.0` or `[::]` bind is
   converted to a loopback RCON destination internally. Do not add duplicate
   endpoint lines. Explicit LAN/public addresses and hostnames are rejected.
3. Add a non-empty password. The simplest option is a line in `server.cfg`:

   ```cfg
   set rcon_password "CHOOSE_A_LOCAL_DEVELOPMENT_PASSWORD"
   ```

   If the standard config already has `#set rcon_password ""`, remove the
   leading `#` and replace the empty value.

   To keep it out of source control, instead create `secrets.cfg` beside
   `server.cfg`, put that line in it, and load it from `server.cfg`:

   ```cfg
   exec secrets.cfg
   ```

   There is intentionally no RCON field in Settings: FXServer and QB Studio
   both read the selected local configuration, so there is only one password
   to maintain. Exclude `secrets.cfg` from Git.

   A stock wildcard bind may still make FXServer reachable through other
   network interfaces depending on Windows Firewall/router settings. QB Studio
   only uses it to discover the port and still sends RCON to loopback. Use a
   local development profile that is never port-forwarded or publicly hosted.
4. In txAdmin, make sure one control profile points its `server.dataPath` to
   that exact server-data folder.
5. Open QB Studio Settings and choose:

   - the `txData` root;
   - the server-data workspace—not the txAdmin control-profile folder;
   - `FXServer.exe` or `cfx-server.exe` from the downloaded server artifact;
   - optionally, `FiveM.exe` or `RedM.exe` for the separate client launcher.

6. Select **Save & Connect**, then use **Start server** in the top bar. Legacy
   FXServer can select a matching named txAdmin profile automatically; current
   Enhanced artifacts use txAdmin's default profile and require a separate
   `txData` root per server. The server runs in the background so it does not
   leave another console window open. While that exact configured process is
   running, the button changes to **Stop server**; use it (or txAdmin) to stop
   the local server before closing QB Studio.

### Create a new local workspace

1. In QB Studio Settings, choose the `txData` root, enter a workspace name and
   port under **Local workspace**, select **Create**, then **Save**.
2. In the new `YourName.base` folder, copy `secrets.cfg.example` to
   `secrets.cfg` and add your own values:

   ```cfg
   sv_licenseKey "YOUR_OWN_LICENSE_KEY"
   set rcon_password "CHOOSE_A_LOCAL_DEVELOPMENT_PASSWORD"
   ```

3. In its `server.cfg`, change `# exec secrets.cfg` to `exec secrets.cfg`.
   `secrets.cfg` is already excluded from Git.
4. Choose `FXServer.exe` or `cfx-server.exe` in QB Studio Settings, save, then
   use **Start server**. In the txAdmin setup that opens, choose **Existing
   Server Data**, point it at the new `.base` folder and its `server.cfg`, then
   select **Save & Start Server**.
   The [official txAdmin setup guide](https://docs.fivem.net/docs/server-manual/setting-up-a-server-txadmin/)
   covers installing and opening txAdmin.
5. Return to QB Studio and select **Save** in Settings again—or restart the
   app—so it rescans the updated configuration and txAdmin attachment.

## How the local connection works

| Feature | Requirement |
| --- | --- |
| Editor, files, and GitHub import | Selected server-data workspace only |
| Start local server | Selected Cfx.re server executable, txData root, and workspace |
| Launch client | Selected `FiveM.exe` or `RedM.exe` |
| Resource list/start/stop/restart | Running FXServer plus matching `rcon_password` |
| Read-only console | Exactly one txAdmin control profile attached to the workspace, with an `fxserver*.log` file |
| AI assistant | Optional configured model provider; no server resource required |

The private MCP runtime is bundled with the desktop app and starts on an
ephemeral loopback port. “Coding runtime ready” means the workspace connection
is ready; it does not mean FXServer itself is running.

## Agent connections and models

Agent Chat starts with Google Gemini selected, but it is not locked to one
provider or account. In **Settings → Agent Chat**, save multiple named
connections, keep a separate protected API key for each hosted connection, and
add the models that connection should expose. Connections may point to the same
service with different accounts, to different hosted providers, or to keyless
local OpenAI-compatible runtimes such as Ollama and LM Studio. Keyless
connections never store or send an API key.

The Agent Chat header groups models by saved connection. Changing the selected
connection or model starts a new chat instead of replaying one provider's
private conversation format into another; an unsent draft is kept. The nearby
settings control jumps directly to the connection editor, while New chat stays
a direct action rather than implying that QB Studio persists chat history. API
keys are write-only in the renderer, encrypted with the operating system's
credential protection, and bound to both the saved connection and its endpoint.
Editing an endpoint therefore cannot forward its old key to a new host.

If resource controls are unavailable, verify the RCON password, restart
FXServer after configuration changes, then save Settings again. If the console
is unavailable, verify the control profile's `server.dataPath` matches the
selected workspace exactly and that txAdmin has started the server at least
once. The Console toolbar can refresh every 1, 2, 5, 10, or 30 seconds (2
seconds by default), or remain manual. Automatic polling pauses while another
QB Studio tab is selected or the app is in the background.

Use the Resources tree context menu to create an empty file, an empty folder,
or a starter resource. The Lua starter contains `fxmanifest.lua`, `config.lua`,
`client.lua`, and `server.lua`. Static NUI adds a ready-to-run local HTML/CSS/JS
interface; React and Vue add editable, version-locked Vite source plus checked-in
local `dist` output, so the resource works before Node or a development server is
installed. Creation never runs package scripts or downloads dependencies. It is
limited to the selected workspace's Resources folder, never overwrites an
existing entry, and rejects unsafe or reserved names. Starter resources can be
created at the Resources root or in a category folder, but not inside another
resource.

The `fxmanifest.lua` form covers current game API sets, scripts, NUI and
loadscreen pages, packfiles, dependencies, exports, data files, supported
runtime options, and resource flags. Custom, structured, and deprecated
metadata remains byte-preserved and editable in Raw mode.

Recognized source locations in console output are links. Selecting one opens a
workspace file in the editor at the reported line and column; resource-relative
locations resolve against that resource. Paths that are outside the selected
workspace, ambiguous, missing, or otherwise unsafe remain unopened and produce
an in-app error instead. Right-click a linked diagnostic (or use the keyboard
context-menu key) and choose **Agent fix** to send a bounded, credential-redacted
resources-relative diagnostic to the assistant and start a fix turn. Console
text is explicitly treated as untrusted data, and any resulting write still
uses the normal review and approval flow.

## Editor intelligence and resource use

Each open file keeps its own Monaco model, so switching tabs preserves undo,
cursor position, folds, diagnostics, and language-service context. Closing a tab
disposes that model instead of retaining the entire workspace in memory. Agent
edits and conflicting disk changes get an on-demand side-by-side review; the
diff editor is not loaded during normal editing.

Lua files receive QBCore, CfxLua, FiveM, and RedM completions, hover details,
signature help, definitions, references, rename, formatting, and diagnostics.
The default **Balanced** mode starts the bundled Lua language server only while
a Lua tab is open, limits workspace preloading to 2,000 files, and throttles
background diagnostics. **Full** mode raises those limits for large machines,
and **Off** disables the process completely. Monaco's language workers and the
Lua service are loaded lazily, so these features do not add polling or CPU work
while Studio is idle on non-code tabs.

Editor font size, word wrap, minimap, sticky scroll, format-on-save, and Lua
intelligence mode are configurable in Settings.

## Discord presence

Discord Rich Presence is off by default. When enabled, it uses Discord's local desktop RPC
connection—there is no bot, OAuth login, token, or Discord credential in QB
Studio. The activity shows the current app area (for example, browsing resources,
monitoring the console, reviewing changes, or working with the assistant) and
the broad active target: FiveM Legacy, FiveM Enhanced, or RedM. While editing or
reviewing, it also shows the active file's basename and a derived language label,
such as `Editing client.lua` and `FiveM Enhanced · Lua`. Full paths, workspace,
profile, server and resource names, file contents, console output, Git data, and
chat contents are never included. The logo tooltip identifies the running QB
Studio version, and fixed **Visit QBCore** and **Download QB Studio** buttons link
to the official website and latest release. Turn **Rich Presence** off in
Settings to clear the activity and stop the local connection. If the Discord
desktop app is not running, QB Studio continues normally and retries quietly.
Discord only displays activity buttons to other users, so they will not appear
when viewing your own presence.

## User theme packs

Use **Settings → Appearance → Import theme** to install a theme, or **Open
themes folder** to edit installed packs and **Reload themes** to apply saved
changes without downloading another QB Studio release. Selecting a theme
previews the app chrome and Monaco editors immediately; **Cancel** restores the
saved theme and **Save & Connect** keeps it.

Theme packs are data-only JSON. QB Studio accepts schema version 1, a lowercase
ID, a built-in base, and allowlisted hexadecimal color values. It rejects CSS,
scripts, URLs, unknown color keys, oversized files, and links. A minimal pack is:

```json
{
  "schemaVersion": 1,
  "id": "qb-red",
  "name": "QB Red",
  "author": "QBCore",
  "base": "dark",
  "colors": {
    "accent": "#d9232e",
    "accent-hover": "#ff4b55",
    "accent-wash": "#3a1518"
  },
  "editor": {
    "colors": {
      "editor.selectionBackground": "#6b2028"
    },
    "tokens": {
      "keyword": "#ff6670"
    }
  }
}
```

The import error identifies unsupported keys, so pack authors can start small
and add only the colors they want to override.

## QB Studio application updates

Installed Windows releases check the official QB Studio GitHub release feed at
startup. The current application version is always visible in the top bar and
in **Settings → About & updates**. A release build never begins downloading an
application update merely because it found one: select **Download update** to
start the download, then select **Restart to update** after verification and
staging finish.

Restarting for an update closes and reopens QB Studio. Save all editor changes
first; QB Studio blocks the update restart while any editor tab has unsaved
changes. Development and unpackaged builds show their version but do not use
the installed-release updater.

Each updater-enabled release publishes three coordinated files: the Windows
installer, `latest.yml`, and the installer's `.blockmap`. The metadata contains
the SHA-512 digest used to check the downloaded installer, while the blockmap
allows differential downloads with a full-download fallback.

## Server artifact updates

In Settings, save the server executable path and select **Check**. Recommended
is the safe default; Latest is an explicit preview-track choice for legacy
FXServer. Both legacy `FXServer.exe` and Enhanced `cfx-server.exe` artifacts
are supported.

Use **Stop server** (or stop it in txAdmin) before selecting **Install update**. QB Studio
downloads from the [official Cfx.re server page](https://docs.fivem.net/docs/server-download/),
checks the expected HTTPS host, size, archive paths, file count, extracted
size, and per-file CRC, then extracts to a sibling staging folder. Only after
that structural validation does it swap the artifact directory. A durable
recovery journal restores or completes the swap after an app/PC interruption.
The previous directory is kept as a sibling backup and is restored
automatically if the swap fails.
`txData`, resources, configs, secrets, and databases are never part of that
replacement.

Cfx.re does not currently publish a separate checksum or signature with these
Windows artifacts, so QB Studio does not claim publisher-signature
verification. It records its own SHA-256 after download for the local install
record.

## Release integrity and signatures

Current release artifacts are unsigned, so Windows may show an “Unknown
publisher” or SmartScreen warning. Application updates are fetched from GitHub
over HTTPS and the downloaded installer is checked against the SHA-512 digest
in the release metadata. Those controls provide integrity within the GitHub
release channel, but they do not independently authenticate the Windows
publisher. Authenticode signing and updater `publisherName` enforcement remain
the priority trust upgrade. Download only from the
`qbcore-framework/qb-studio` release channel and verify the GitHub build
attestation when checking a release manually:

```powershell
gh attestation verify <installer> -R qbcore-framework/qb-studio --signer-workflow qbcore-framework/qb-studio/.github/workflows/release.yml
```

After publication, a separate least-privilege workflow job records build and
CycloneDX SBOM attestations for the installer. Users do not need to download
`latest.yml` or the blockmap manually; the installed updater consumes them.
Treat a release as attested only after that job succeeds; see the [build
guide](BUILDING.md) for the residual non-atomic publication window.

## Code signing policy

QB Studio has applied to the SignPath Foundation open-source program for
Authenticode signing. Free code signing provided by SignPath.io, certificate by
SignPath Foundation.

Releases published before approval remain unsigned. After onboarding, signed
builds will be published as new releases rather than silently replacing
existing assets. See the full [code signing policy](CODE_SIGNING_POLICY.md)
for the controlled build and approval process, and review the
[privacy policy](PRIVACY.md) for local storage and optional third-party network
features.

Potential vulnerabilities should be reported privately according to the
[security policy](SECURITY.md), never through a public issue containing secrets
or exploit details.

## Build from source

The reproducible toolchain is Node.js `24.20.0` with npm `11.19.0` on Windows
x64. From the repository root:

```powershell
npm ci
npm audit signatures
npm run check:static
npm run audit:dependencies
npm run prepare:luals
npm run typecheck
npm test
npm run dist
npm run verify:package
```

For development without installing the app, run:

```powershell
npm run dev -w qb-studio
```

See [BUILDING.md](BUILDING.md) for output locations, the complete package
checks, SBOM scope, and release recovery guidance.

Installed release builds check the official GitHub release feed at startup.
Finding an update does not download or install it: download is always
user-initiated, and installation requires an explicit **Restart to update**
after unsaved editor changes have been saved.

Conventional commits on `main` are automatically versioned by semantic-release
and published as GitHub Releases. Dependency updates are proposed weekly and
must pass the same Windows build, test, audit, and package-verification gates;
see the [dependency policy](DEPENDENCY_POLICY.md).

## License and trademarks

MIT licensed and maintained by QBCore Framework. QB Studio is not approved,
sponsored, or endorsed by Cfx.re, Rockstar Games, or Take-Two Interactive.
Those product names are used only to describe compatibility.
