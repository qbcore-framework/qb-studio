# Dependency policy

Last reviewed: August 30, 2026

QB Studio uses the reviewed Node.js `24.20.0` and bundled npm `11.19.0`
toolchain recorded in `.nvmrc` and `package.json`. The committed
`package-lock.json` is the source of truth for reproducible installs. A newer
version is not adopted when
it drops a required platform, is prerelease-only, or fails the repository's
security, behavior, packaging, or performance checks.

## Automated update proposals

Dependabot checks npm packages and GitHub Actions every week. Compatible minor
and patch npm updates are grouped to keep review noise manageable; major
updates remain separate so migrations and resource impact are visible. Updates
are never auto-merged.

The direct `@types/node` major stays aligned with the supported Node.js runtime
major. Dependabot does not propose a newer typings major independently; a Node
major upgrade is reviewed as an explicit runtime, CI, typings, and documentation
migration.

Every dependency change must pass on Windows:

```powershell
npm ci
npm audit signatures
npm run check:static
npm run audit:dependencies
npm run prepare:luals
npm run verify:lua-definitions
npm run typecheck
npm test
npm run dist
npm run verify:package
```

The audit covers the complete lockfile and blocks moderate-or-higher
advisories. A production-only audit is insufficient because Vite bundles
development-classified renderer libraries into the shipped application. The
release SBOM likewise covers the complete locked graph so those bundled
libraries remain visible; it is intentionally broader than an exact inventory
of files copied beside the executable.

The packaged-runtime check verifies the renderer manifest, private loopback
runtime, native window-integration module, FiveM, RedM, and curated QBCore Lua
definition packs, pinned Lua language-server executable and license, package
metadata, and exclusion of application test/source-map/secret files from the
unpacked release—not only the source tree.

GitHub Actions are pinned to reviewed full commit SHAs. Dependabot may propose
new action versions, but reviewers must resolve the tag to its reviewed commit
instead of merging a mutable tag reference.

Dependency install hooks fail closed. The root `allowScripts` map contains
reviewed approvals for the native-module, bundler, installer, and SBOM hooks.
Koffi requires a name-based approval because npm omits the registry URL from
its nested workspace lock entry, so its direct dependency and the static check
separately pin version `3.1.6`; the other approvals are version-qualified. Any
new pending hook must be inspected and explicitly approved. Do not bypass the
gate with `--dangerously-allow-all-scripts`.

## Bundled Lua language server

LuaLS is an executable dependency rather than an npm package, so it is pinned
to an exact version and SHA-256 in `scripts/luals-release.json`. The preparation
script only downloads the official LuaLS Windows x64 release, rejects a
checksum mismatch, applies bounded path and extraction limits, and requires the
upstream license before installing the bundle. The MIT license and source
marker are shipped with the application.

A weekly GitHub Actions check compares that manifest with the latest stable
upstream release. It maintains one repository issue when the pin is stale and
closes the reminder after the reviewed pin catches up; it never changes the pin,
downloads a new executable into the repository, or opens an automatic update PR.

Updating LuaLS requires reviewing its release notes and license, changing both
the version and checksum, running the end-to-end CfxLua completion test, and
rebuilding the installer. This deliberate pin prevents a release build from
silently acquiring a different native executable.

## Bundled Lua definition packs

QB Studio exposes exactly three definition products beneath
`fivem-studio/resources/lua-library`: `fivem`, `redm`, and `qbcore`. FiveM
targets load FiveM plus QBCore; RedM loads only RedM. Shared runtime declarations
are intentionally duplicated into the two engine packs, so there is no fourth
platform definition product.

Engine definitions are locked by `scripts/lua-definitions-release.json`. The
FiveM/RedM game declarations and reviewed LuaLS plugin come from one exact
`overextended/fivem-lls-addon` commit and archive checksum. Platform signatures
come from the exact checksum-pinned official JSON snapshot. FiveM generation
accepts untagged and `gta5` records; RedM accepts explicit `rdr3` records plus
the reviewed, version-controlled common allowlist. Generated platform files
contain signature facts and documentation links, not copied upstream prose or
examples. QBCore remains a separately maintained source file and is carried
forward without regeneration.

To update the reviewed inputs, change the exact commit/checksums and, when
needed, the RedM allowlist, then run:

```powershell
npm run update:lua-definitions
npm run verify:lua-definitions
npm run typecheck
npm test
npm run dist
npm run verify:package
```

The updater downloads into bounded temporary storage, verifies every source
before extraction, generates into a staging directory, and swaps the bundle
only after validation. Ordinary development, test, build, and release gates
run the offline verifier only; they never follow a moving upstream branch or
silently fetch a different definition snapshot. Reviewers must inspect count,
signature, target-filter, provenance, license, and completion-test changes
before accepting a new lock.

## Resource-impact review

Updates to Electron, Monaco, LuaLS, model SDKs, or native modules require a
production renderer build and installer-size comparison. Editor services must
remain demand-driven: per-tab Monaco models are disposed when closed, the diff
editor loads only for a requested review, and Balanced Lua intelligence stops
when no Lua file is open.
