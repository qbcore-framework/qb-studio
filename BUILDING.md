# Building QB Studio

## Supported toolchain

The repository pins Node.js `24.20.0` in `.nvmrc` and npm `11.19.0` in
`package.json`. Use those exact versions when reproducing CI or a release. The
full test and packaging gates require Windows x64 because they exercise the
bundled Windows Lua language server, Windows process checks, Electron, and NSIS.

Install the single lockfile from the repository root:

```powershell
npm ci
```

Workspace-level lockfiles are intentionally unsupported. Do not run `npm
install` from either workspace or commit a nested lockfile.

The root `allowScripts` map approves only the exact reviewed packages whose
install hooks are required by the native module, bundler, installer builder,
and SBOM tooling. `.npmrc` enables strict enforcement, so `npm ci` fails when a
dependency update introduces a new or changed install script until it is
reviewed and pinned. npm's workspace lock entry for Koffi has no registry URL,
so that approval must be name-based; the direct dependency and repository
invariant check separately pin Koffi to `3.1.6`.

## Quality gate

Run the same checks used for dependency review and release qualification:

```powershell
npm audit signatures
npm run check:static
npm run audit:dependencies
npm run prepare:luals
npm run typecheck
npm test
```

The dependency audit includes development-classified packages at a `moderate`
failure threshold. Vite bundles some of those packages, including Monaco's
renderer dependencies, into the shipped application; a production-only npm
audit is therefore not a valid release gate.

`prepare:luals` downloads only the release recorded in
`scripts/luals-release.json`, verifies its SHA-256, and caches the verified
Windows x64 bundle under `vendor/`. That generated directory is not committed.
The desktop `pretest` hook similarly prepares Electron once before Node starts
test files in parallel, avoiding races in Electron's lazy binary download.

## Build and package

Build the renderer, Electron main process, and bundled private runtime without
creating an installer:

```powershell
npm run build
```

Build and verify the unsigned Windows installer and its updater metadata:

```powershell
npm run dist
npm run verify:package
```

Generated output is written below `fivem-studio/dist`,
`fivem-studio/dist-electron`, `fivem-mcp-server/bundle`, and `release`. The
package verifier checks the exact versioned installer, renderer manifest,
native Koffi module, bundled runtime identity, LuaLS pin and license, Lua
definitions, and exclusion of application tests, source maps, and local secret
files. Release qualification additionally requires the exact `latest.yml` and
installer blockmap generated with that installer; the release workflow rejects
a missing or ambiguously named member of the updater set.

## Release lifecycle

Conventional commits merged to `main` are evaluated by semantic-release. When
a release is required, its prepare phase updates package metadata in the
working copy without resolving dependency ranges again, builds the installer,
verifies that exact installer, and creates a CycloneDX SBOM for the complete
locked dependency graph. The GitHub plugin then publishes the coordinated
updater set: exactly one versioned Windows installer, `latest.yml`, and the
matching versioned `.blockmap`. A release missing any member of that set is not
usable by the installed updater and must fail release qualification.

The current artifacts are unsigned. GitHub HTTPS transport plus the SHA-512
digest in `latest.yml` protect the downloaded bytes within the GitHub release
channel, but do not provide independent publisher identity. Authenticode
signing remains the priority trust upgrade. Once signing is available, the
final installer must be signed before its updater metadata is finalized,
because signing changes the installer bytes. Package verification must then
confirm that `latest.yml` describes the final signed file and that packaged
`app-update.yml` contains the exact certificate subject used by
`electron-updater` as `publisherName`.

A separate least-privilege job downloads the exact installer and SBOM staged by
the publish job and records GitHub build-provenance and SBOM attestations. This
separation keeps `contents: write` away from the OIDC job, but GitHub Actions
cannot make `actions/attest` atomic with semantic-release's publish lifecycle.
There can be a short interval after publication before attestations appear. If
the attestation job fails, the release remains published but must not be
described as attested; rerun the failed job against its one-day workflow
artifact, or publish a new release if the inputs can no longer be recovered.
Never replace an existing release asset silently.
