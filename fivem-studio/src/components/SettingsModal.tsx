import { useEffect, useState } from "react";
import type {
  AppUpdateState,
  ArtifactProgress,
  ArtifactStatus,
  CfxTarget,
  DetectedClientInstalls,
  DetectedExecutableInstalls,
  DevelopmentRconPreview,
  ProfileInfo,
  SetupDiagnostics,
  StudioConfig,
  ThemePack,
  ThemePreference,
} from "../global";
import { t } from "../i18n";
import { COST_LABEL, PROVIDER_PRESETS, matchPreset } from "../providerPresets";
import { useDialogFocus } from "../hooks/useDialogFocus";
import SetupChecklist from "./SetupChecklist";
import AppUpdateControl from "./AppUpdateControl";

interface SettingsModalProps {
  config: StudioConfig;
  themePacks: ThemePack[];
  appUpdateState: AppUpdateState;
  appUpdateBusy?: boolean;
  onCheckAppUpdate: () => void | Promise<void>;
  onDownloadAppUpdate: () => void | Promise<void>;
  onRestartAppUpdate: () => void | Promise<void>;
  onThemePreview: (preference: ThemePreference) => void;
  onReloadThemePacks: () => Promise<ThemePack[]>;
  onSave: (config: StudioConfig) => Promise<void>;
  onClose: () => void;
}

const CFX_TARGETS: readonly CfxTarget[] = ["legacy", "enhanced", "redm"];

function cfxTargetLabel(target: CfxTarget): string {
  if (target === "legacy") return "FiveM Legacy";
  if (target === "enhanced") return "FiveM Enhanced";
  return "RedM";
}

function serverExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFxServerExePath;
  if (target === "enhanced") return config.enhancedFxServerExePath;
  return config.redmFxServerExePath;
}

function clientExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFivemExePath;
  if (target === "enhanced") return config.enhancedFivemExePath;
  return config.redmClientExePath;
}

export default function SettingsModal({
  config,
  themePacks,
  appUpdateState,
  appUpdateBusy,
  onCheckAppUpdate,
  onDownloadAppUpdate,
  onRestartAppUpdate,
  onThemePreview,
  onReloadThemePacks,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [draft, setDraft] = useState<StudioConfig>(config);
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  // The stored key is never readable from here — the main process only reports
  // whether one exists. An empty box therefore means "leave whatever's saved
  // alone", not "clear it"; clearing is an explicit button.
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [hasLocalKey, setHasLocalKey] = useState(false);
  const [localKeyDraft, setLocalKeyDraft] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [toolCapable, setToolCapable] = useState<Record<string, boolean> | undefined>();
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspacePort, setWorkspacePort] = useState("30120");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [artifactStatus, setArtifactStatus] = useState<ArtifactStatus | null>(null);
  const [artifactBusy, setArtifactBusy] = useState<"checking" | "updating" | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactMessage, setArtifactMessage] = useState<string | null>(null);
  const [artifactProgress, setArtifactProgress] = useState<ArtifactProgress | null>(null);
  const [detectedClients, setDetectedClients] = useState<DetectedClientInstalls>({ legacy: null, enhanced: null, redm: null });
  const [detectedServers, setDetectedServers] = useState<DetectedClientInstalls>({ legacy: null, enhanced: null, redm: null });
  const [detectingExecutable, setDetectingExecutable] = useState<string | null>(null);
  const [setupDiagnostics, setSetupDiagnostics] = useState<SetupDiagnostics | null>(null);
  const [diagnosticsEpoch, setDiagnosticsEpoch] = useState(0);
  const [rconPreview, setRconPreview] = useState<DevelopmentRconPreview | null>(null);
  const [rconBusy, setRconBusy] = useState(false);
  const [themeBusy, setThemeBusy] = useState<"import" | "reload" | null>(null);

  // The console (including its popout) owns this preference. Keep the hidden
  // field current while Settings is open so saving an unrelated setting cannot
  // restore the interval that was present when the modal first mounted.
  useEffect(() => {
    setDraft((current) => current.consoleRefreshIntervalMs === config.consoleRefreshIntervalMs
      ? current
      : { ...current, consoleRefreshIntervalMs: config.consoleRefreshIntervalMs });
  }, [config.consoleRefreshIntervalMs]);

  /** Asks the endpoint what it actually serves, rather than making the user guess a model id. */
  async function loadModels() {
    setLoadingModels(true);
    setModelsError(null);
    try {
      // Pass the typed key so this works before Save, when nothing is stored yet.
      const result = await window.api.agent.listModels(draft.openaiBaseUrl, localKeyDraft.trim() || undefined);
      if (result.ok && result.models) {
        setModels(result.models);
        setToolCapable(result.toolCapable);
        // Nothing chosen yet, or the saved id isn't on this endpoint — pick a sane one.
        // The preset's own recommendation wins over a keyword match, which would
        // otherwise just take whatever sorted first (e.g. gemini-2.5 over 3.7).
        // Where capabilities are known, never auto-pick a model that can't call tools.
        if (!draft.openaiModel || !result.models.includes(draft.openaiModel)) {
          const usable = result.toolCapable
            ? result.models.filter((m) => result.toolCapable![m] !== false)
            : result.models;
          const pool = usable.length > 0 ? usable : result.models;
          const preferred =
            (preset.model && pool.includes(preset.model) ? preset.model : undefined) ??
            pool.find((m) => /flash|instruct|coder/i.test(m)) ??
            pool[0];
          setDraft((d) => ({ ...d, openaiModel: preferred }));
        }
      } else {
        setModels([]);
        setToolCapable(undefined);
        setModelsError(result.error ?? "Could not list models.");
      }
    } catch (err) {
      setModels([]);
      setToolCapable(undefined);
      setModelsError((err as Error).message || "Could not list models.");
    } finally {
      setLoadingModels(false);
    }
  }

  const preset = matchPreset(draft.agentProvider, draft.openaiBaseUrl);
  const isAnthropic = draft.agentProvider === "anthropic";
  const activeTarget = draft.activeCfxTarget;
  const activeServerPath = serverExeFor(draft, activeTarget);
  const activeClientPath = clientExeFor(draft, activeTarget);
  const savedActiveServerPath = serverExeFor(config, activeTarget);
  const artifactTrack = activeTarget === "enhanced"
    ? "recommended"
    : activeTarget === "redm"
      ? draft.redmArtifactTrack
      : draft.legacyArtifactTrack;
  const serverPathIsSaved = Boolean(activeServerPath && activeServerPath === savedActiveServerPath);

  useEffect(() => {
    let cancelled = false;
    window.api.installs.detectAll(config.txDataPath).then((found) => {
      if (cancelled) return;
      setDetectedClients(found.clients);
      setDetectedServers(found.servers);
      setDraft((current) => ({
        ...current,
        legacyFivemExePath: current.legacyFivemExePath ?? found.clients.legacy,
        enhancedFivemExePath: current.enhancedFivemExePath ?? found.clients.enhanced,
        redmClientExePath: current.redmClientExePath ?? found.clients.redm,
        legacyFxServerExePath: current.legacyFxServerExePath ?? found.servers.legacy,
        enhancedFxServerExePath: current.enhancedFxServerExePath ?? found.servers.enhanced,
        redmFxServerExePath: current.redmFxServerExePath ?? found.servers.redm,
      }));
    }).catch(() => {
      // Browse remains the complete fallback when conventional discovery fails.
    });
    return () => { cancelled = true; };
  }, []);

  function applyDetectedExecutables(current: StudioConfig, found: DetectedExecutableInstalls): StudioConfig {
    return {
      ...current,
      legacyFivemExePath: current.legacyFivemExePath ?? found.clients.legacy,
      enhancedFivemExePath: current.enhancedFivemExePath ?? found.clients.enhanced,
      redmClientExePath: current.redmClientExePath ?? found.clients.redm,
      legacyFxServerExePath: current.legacyFxServerExePath ?? found.servers.legacy,
      enhancedFxServerExePath: current.enhancedFxServerExePath ?? found.servers.enhanced,
      redmFxServerExePath: current.redmFxServerExePath ?? found.servers.redm,
    };
  }

  async function autoDetect(target?: CfxTarget, kind?: "client" | "server") {
    const key = target && kind ? `${target}-${kind}` : "all";
    setDetectingExecutable(key);
    setArtifactError(null);
    try {
      const found = await window.api.installs.detectAll(draft.txDataPath);
      setDetectedClients(found.clients);
      setDetectedServers(found.servers);
      if (!target || !kind) {
        setDraft((current) => applyDetectedExecutables(current, found));
        const count = [...Object.values(found.clients), ...Object.values(found.servers)].filter(Boolean).length;
        if (count === 0) setArtifactError("No conventional Cfx.re executables were found. Use Browse for custom locations.");
        return;
      }
      const executable = kind === "client" ? found.clients[target] : found.servers[target];
      if (!executable) {
        setArtifactError(`No conventional ${cfxTargetLabel(target)} ${kind} executable was found. Use Browse for a custom location.`);
        return;
      }
      setDraft((current) => {
        if (kind === "client") {
          if (target === "legacy") return { ...current, legacyFivemExePath: executable };
          if (target === "enhanced") return { ...current, enhancedFivemExePath: executable };
          return { ...current, redmClientExePath: executable };
        }
        if (target === "legacy") return { ...current, legacyFxServerExePath: executable };
        if (target === "enhanced") return { ...current, enhancedFxServerExePath: executable };
        return { ...current, redmFxServerExePath: executable };
      });
    } catch (error) {
      setArtifactError((error as Error).message || "Could not auto-detect Cfx.re executables.");
    } finally {
      setDetectingExecutable(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setSetupDiagnostics(null);
    window.api.setup.diagnostics(
      draft.txDataPath,
      draft.selectedProfile,
      activeTarget,
      activeClientPath,
      activeServerPath,
    ).then((result) => {
      if (!cancelled) setSetupDiagnostics(result);
    }).catch(() => {
      if (!cancelled) setSetupDiagnostics({
        txDataRoot: false,
        workspace: false,
        serverExecutable: false,
        clientExecutable: false,
        txAdminAttachment: false,
        rconCapability: false,
        git: false,
      });
    });
    return () => { cancelled = true; };
  }, [draft.txDataPath, draft.selectedProfile, activeTarget, activeClientPath, activeServerPath, diagnosticsEpoch]);

  /** Picking a provider fills in its endpoint and a starting model; both stay editable. */
  function applyPreset(id: string) {
    const next = PROVIDER_PRESETS.find((p) => p.id === id);
    if (!next) return;
    if (next.id === "anthropic") {
      setDraft((d) => ({ ...d, agentProvider: "anthropic" }));
      return;
    }
    setDraft((d) => ({
      ...d,
      agentProvider: "openai",
      // "Custom" keeps whatever's already typed rather than blanking it.
      openaiBaseUrl: next.id === "custom" ? d.openaiBaseUrl : next.baseUrl,
      openaiModel: next.id === "custom" ? d.openaiModel : next.model,
    }));
  }

  useEffect(() => {
    window.api.agent.hasApiKey().then(setHasApiKey);
  }, []);

  // Re-check per endpoint: keys are stored per provider, so switching the picker
  // must not keep showing "a key is saved" from the previous one.
  useEffect(() => {
    setLocalKeyDraft("");
    setModels([]);
    setModelsError(null);
    window.api.agent.hasProviderKey(draft.openaiBaseUrl).then(setHasLocalKey);
  }, [draft.openaiBaseUrl]);

  useEffect(() => {
    if (!draft.txDataPath) {
      setProfiles([]);
      return;
    }
    let cancelled = false;
    window.api.txdata
      .listProfiles(draft.txDataPath)
      .then((found) => {
        if (cancelled) return;
        setProfiles(found);
        setProfilesError(null);
        // Keep the current selection if it's still present, otherwise default to the first profile found.
        setDraft((d) => ({
          ...d,
          selectedProfile: found.some((p) => p.name === d.selectedProfile) ? d.selectedProfile : (found[0]?.name ?? null),
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setProfiles([]);
        setProfilesError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.txDataPath]);

  async function pickTxDataFolder() {
    const folder = await window.api.dialog.chooseFolder();
    if (folder) setDraft((d) => ({ ...d, txDataPath: folder, selectedProfile: null }));
  }

  async function pickExe(target: CfxTarget) {
    try {
      const exe = await window.api.dialog.chooseExe(target);
      if (!exe) return;
      setDraft((d) => {
        if (target === "legacy") return { ...d, legacyFivemExePath: exe };
        if (target === "enhanced") return { ...d, enhancedFivemExePath: exe };
        return { ...d, redmClientExePath: exe };
      });
    } catch (err) {
      setArtifactError((err as Error).message);
    }
  }

  async function pickFxServerExe(target: CfxTarget) {
    try {
      const exe = await window.api.dialog.chooseFxServerExe(target);
      if (!exe) return;
      setDraft((d) => {
        if (target === "legacy") return { ...d, legacyFxServerExePath: exe };
        if (target === "enhanced") return { ...d, enhancedFxServerExePath: exe };
        return { ...d, redmFxServerExePath: exe };
      });
    } catch (err) {
      setArtifactError((err as Error).message);
    }
  }

  async function checkArtifacts() {
    setArtifactBusy("checking");
    setArtifactError(null);
    setArtifactMessage(null);
    try {
      const status = await window.api.artifacts.check(activeTarget, artifactTrack);
      setArtifactStatus(status);
      if (status.recoveryNotice) setArtifactMessage(status.recoveryNotice);
    } catch (err) {
      setArtifactStatus(null);
      setArtifactError((err as Error).message || "Could not check Cfx.re artifacts.");
    } finally {
      setArtifactBusy(null);
    }
  }

  async function updateArtifacts() {
    if (!artifactStatus) return;
    const target = activeServerPath ? activeServerPath.replace(/[\\/][^\\/]+$/, "") : "the artifact folder";
    if (
      !confirm(
        `Install Cfx.re build ${artifactStatus.build} into ${target}?\n\n` +
          "The local server must be stopped. QB Studio will replace only the artifact folder, keep the previous folder as a backup, and never modify txData.",
      )
    ) {
      return;
    }
    setArtifactBusy("updating");
    setArtifactError(null);
    setArtifactMessage(null);
    setArtifactProgress({ target: activeTarget, phase: "checking", transferredBytes: 0, totalBytes: artifactStatus.archiveSize });
    try {
      const result = await window.api.artifacts.update(activeTarget, artifactTrack);
      setArtifactStatus(result);
      setArtifactMessage(
        `Installed build ${result.build}. Previous artifacts are preserved at ${result.backupPath}.` +
          (result.warning ? ` ${result.warning}` : ""),
      );
    } catch (err) {
      setArtifactError((err as Error).message || "Could not update Cfx.re artifacts.");
    } finally {
      setArtifactBusy(null);
    }
  }

  useEffect(() => {
    setArtifactStatus(null);
    setArtifactError(null);
    setArtifactMessage(null);
    setArtifactProgress(null);
  }, [activeTarget, activeServerPath, artifactTrack]);

  useEffect(() => window.api.artifacts.onProgress((progress) => {
    if (progress.target === activeTarget) setArtifactProgress(progress);
  }), [activeTarget]);

  async function createWorkspace() {
    if (!draft.txDataPath) {
      setSaveError("Choose a txData folder before creating a local workspace.");
      return;
    }
    setCreatingWorkspace(true);
    setSaveError(null);
    setWorkspaceMessage(null);
    try {
      const created = await window.api.txdata.createLocalWorkspace(
        draft.txDataPath,
        workspaceName,
        Number(workspacePort),
        draft.activeCfxTarget,
      );
      const found = await window.api.txdata.listProfiles(draft.txDataPath);
      setProfiles(found);
      setProfilesError(null);
      setDraft((d) => ({ ...d, selectedProfile: created.name }));
      setWorkspaceMessage(t("setup.workspace.created", { workspace: created.name }));
      setWorkspaceName("");
      setDiagnosticsEpoch((epoch) => epoch + 1);
    } catch (err) {
      setSaveError((err as Error).message || "Could not create the local workspace.");
    } finally {
      setCreatingWorkspace(false);
    }
  }

  function showWorkspaceControls() {
    document.getElementById("local-workspace-settings")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function previewRconSetup() {
    if (!draft.txDataPath || !draft.selectedProfile) {
      setSaveError(t("setup.rcon.needWorkspace"));
      showWorkspaceControls();
      return;
    }
    setRconBusy(true);
    setSaveError(null);
    try {
      setRconPreview(await window.api.txdata.previewDevelopmentRcon(draft.txDataPath, draft.selectedProfile));
    } catch (error) {
      setSaveError((error as Error).message || t("setup.rcon.needWorkspace"));
    } finally {
      setRconBusy(false);
    }
  }

  async function applyRconSetup() {
    if (!draft.txDataPath || !draft.selectedProfile || !rconPreview) return;
    const allowOverwrite = rconPreview.hasExistingPassword
      ? confirm(t("setup.rcon.confirmRotate"))
      : false;
    if (rconPreview.hasExistingPassword && !allowOverwrite) return;
    setRconBusy(true);
    setSaveError(null);
    try {
      await window.api.txdata.applyDevelopmentRcon(draft.txDataPath, draft.selectedProfile, allowOverwrite);
      setRconPreview(null);
      setWorkspaceMessage(t("setup.rcon.applied"));
      setDiagnosticsEpoch((epoch) => epoch + 1);
    } catch (error) {
      setSaveError((error as Error).message || t("setup.rcon.applyError"));
    } finally {
      setRconBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setSaveError(null);
    try {
      // Profile-switch confirmation and main-process validation must succeed
      // before any write-only credentials are changed.
      await onSave(draft);
      if (apiKeyDraft.trim()) await window.api.agent.setApiKey(apiKeyDraft.trim());
      if (localKeyDraft.trim()) await window.api.agent.setProviderKey(draft.openaiBaseUrl, localKeyDraft.trim());
      onClose();
    } catch (err) {
      setSaveError((err as Error).message || "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  async function clearApiKey() {
    await window.api.agent.setApiKey("");
    setHasApiKey(false);
    setApiKeyDraft("");
  }

  async function clearLocalApiKey() {
    await window.api.agent.setProviderKey(draft.openaiBaseUrl, "");
    setHasLocalKey(false);
    setLocalKeyDraft("");
  }

  async function importThemePack() {
    setThemeBusy("import");
    setSaveError(null);
    try {
      const imported = await window.api.theme.importPack();
      if (!imported) return;
      await onReloadThemePacks();
      const preference = `custom:${imported.id}` as ThemePreference;
      setDraft((current) => ({ ...current, theme: preference }));
      onThemePreview(preference);
    } catch (error) {
      setSaveError((error as Error).message || "Could not import the theme pack.");
    } finally {
      setThemeBusy(null);
    }
  }

  async function reloadThemes() {
    setThemeBusy("reload");
    setSaveError(null);
    try {
      await onReloadThemePacks();
    } catch (error) {
      setSaveError((error as Error).message || "Could not reload theme packs.");
    } finally {
      setThemeBusy(null);
    }
  }

  const operationBusy = busy || creatingWorkspace || artifactBusy !== null || detectingExecutable !== null
    || loadingModels || themeBusy !== null || rconBusy;
  const restartBlockedReason = operationBusy
    ? t("appUpdate.restartBlockedOperation")
    : JSON.stringify(draft) !== JSON.stringify(config)
      || apiKeyDraft.trim() !== ""
      || localKeyDraft.trim() !== ""
      || workspaceName.trim() !== ""
      || workspacePort !== "30120"
      || rconPreview !== null
      ? t("appUpdate.restartBlockedSettings")
      : null;
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose, !operationBusy);

  useEffect(() => {
    if (saveError) document.getElementById("settings-save-error")?.focus();
  }, [saveError]);

  return (
    <div className="modal-backdrop" onClick={() => !operationBusy && onClose()}>
      <div ref={dialogRef} className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h3 id="settings-title" data-dialog-initial-focus tabIndex={-1}>Settings</h3>

        {saveError && <div id="settings-save-error" className="error-text settings-save-error" role="alert" tabIndex={-1}>{saveError}</div>}

        <div className="settings-divider">{t("appUpdate.section")}</div>
        <AppUpdateControl
          state={appUpdateState}
          busy={appUpdateBusy}
          onCheck={onCheckAppUpdate}
          onDownload={onDownloadAppUpdate}
          onRestart={onRestartAppUpdate}
          restartBlockedReason={restartBlockedReason}
        />

        <div className="settings-divider">{t("appearance.section")}</div>
        <label className="field-label">{t("appearance.theme")}</label>
        <select
          value={draft.theme}
          onChange={(event) => {
            const theme = event.target.value as StudioConfig["theme"];
            setDraft((current) => ({ ...current, theme }));
            onThemePreview(theme);
          }}
        >
          <option value="system">{t("appearance.theme.system")}</option>
          <option value="dark">{t("appearance.theme.dark")}</option>
          <option value="light">{t("appearance.theme.light")}</option>
          <option value="high-contrast">{t("appearance.theme.highContrast")}</option>
          {draft.theme.startsWith("custom:") && !themePacks.some((pack) => `custom:${pack.id}` === draft.theme) && (
            <option value={draft.theme}>Missing custom theme</option>
          )}
          {themePacks.map((pack) => (
            <option key={pack.id} value={`custom:${pack.id}`}>
              {pack.name}{pack.author ? ` — ${pack.author}` : ""}
            </option>
          ))}
        </select>
        <div className="field-hint">{t("appearance.themeHelp")} Selecting a theme previews it immediately; Cancel restores the saved theme.</div>
        <div className="field-row" style={{ marginBottom: 8 }}>
          <button className="btn" type="button" onClick={() => void importThemePack()} disabled={themeBusy !== null}>
            {themeBusy === "import" ? "Importing…" : "Import theme…"}
          </button>
          <button className="btn" type="button" onClick={() => void reloadThemes()} disabled={themeBusy !== null}>
            {themeBusy === "reload" ? "Reloading…" : "Reload themes"}
          </button>
          <button className="btn" type="button" onClick={() => void window.api.theme.openPackFolder()}>
            Open themes folder
          </button>
        </div>
        <div className="field-hint">
          Theme packs are JSON files stored outside the app release. Only allowlisted hexadecimal UI and editor colors are accepted; scripts, CSS, URLs, and linked files are rejected.
        </div>
        <label className="field-label">{t("appearance.uiScale")}</label>
        <select
          value={draft.uiScale}
          onChange={(event) => setDraft((current) => ({ ...current, uiScale: Number(event.target.value) }))}
        >
          {[0.8, 0.9, 1, 1.1, 1.25, 1.5].map((scale) => (
            <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>
          ))}
        </select>
        <div className="field-hint">{t("appearance.uiScaleHelp")}</div>

        <div className="settings-divider">{t("console.section")}</div>
        <label className="field-label">
          {t("console.notifyExit")}
          <select
            value={draft.notifyOnServerExit ? "on" : "off"}
            onChange={(event) => setDraft((current) => ({
              ...current,
              notifyOnServerExit: event.target.value === "on",
            }))}
          >
            <option value="on">{t("common.on")}</option>
            <option value="off">{t("common.off")}</option>
          </select>
        </label>
        <div className="field-hint">{t("console.notifyExitHelp")}</div>

        <div className="settings-divider">Discord</div>
        <label className="field-label">
          Rich Presence
          <select
            value={draft.discordPresenceEnabled ? "on" : "off"}
            onChange={(event) => setDraft((current) => ({ ...current, discordPresenceEnabled: event.target.value === "on" }))}
          >
            <option value="on">{t("common.on")} — recommended</option>
            <option value="off">{t("common.off")}</option>
          </select>
        </label>
        <div className="field-hint">
          Off by default. When enabled, Discord sees the current QB Studio area, broad target, and—while editing or reviewing—the active file's basename and language. Full paths, workspace, profile, server, resource, code, console, and chat contents are never included. No Discord token is used.
        </div>

        <SetupChecklist
          diagnostics={setupDiagnostics}
          targetLabel={cfxTargetLabel(activeTarget)}
          actions={{
            txDataRoot: () => void pickTxDataFolder(),
            workspace: showWorkspaceControls,
            serverExecutable: () => void pickFxServerExe(activeTarget),
            clientExecutable: () => void pickExe(activeTarget),
            txAdminAttachment: () => void window.api.shell.openExternal("https://docs.fivem.net/docs/server-manual/setting-up-a-server-txadmin/"),
            rconCapability: () => void previewRconSetup(),
            git: () => void window.api.shell.openExternal("https://git-scm.com/download/win"),
          }}
        />

        {rconPreview && (
          <section className="rcon-preview" aria-label={t("setup.rcon.previewTitle")}>
            <strong>{t("setup.rcon.previewTitle")}</strong>
            <div className="field-hint">{t("setup.rcon.previewHelp")}</div>
            {rconPreview.hasExistingPassword && (
              <div className="field-hint" style={{ color: "var(--yellow)" }}>{t("setup.rcon.existing")}</div>
            )}
            <div className="rcon-preview-list">
              {rconPreview.changes.map((change) => (
                <div className="rcon-preview-row" key={change.path}>
                  <code>{change.path}</code>
                  <span>
                    {change.action === "create"
                      ? t("setup.rcon.action.create")
                      : change.action === "update"
                        ? t("setup.rcon.action.update")
                        : t("setup.rcon.action.unchanged")}
                  </span>
                  <span>
                    {change.description === "load-secret-file"
                      ? t("setup.rcon.change.load-secret-file")
                      : change.description === "write-redacted-password"
                        ? t("setup.rcon.change.write-redacted-password")
                        : t("setup.rcon.change.ignore-secret-file")}
                  </span>
                </div>
              ))}
            </div>
            <div className="rcon-preview-actions">
              <button className="btn" type="button" onClick={() => setRconPreview(null)} disabled={rconBusy}>
                {t("setup.rcon.cancel")}
              </button>
              <button className="btn primary" type="button" onClick={() => void applyRconSetup()} disabled={rconBusy}>
                {rconBusy ? t("setup.rcon.applying") : t("setup.rcon.apply")}
              </button>
            </div>
          </section>
        )}

        <label className="field-label">txData root</label>
        <div className="field-row">
          <input value={draft.txDataPath ?? ""} readOnly placeholder="Not set" />
          <button className="btn" onClick={pickTxDataFolder}>
            Browse…
          </button>
        </div>

        <label className="field-label">Server-data workspace</label>
        <div className="field-hint">
          Select the editable folder that contains <code>server.cfg</code> and <code>resources/</code>, usually a
          <code>*.base</code> folder—not txAdmin's control-profile folder.
        </div>
        <div style={{ marginBottom: 10 }}>
          {!draft.txDataPath ? (
            <div className="field-hint">Pick a txData folder above first.</div>
          ) : profilesError ? (
            <div className="error-text">{profilesError}</div>
          ) : profiles.length === 0 ? (
            <div className="field-hint">No profiles found — looking for subfolders with a server.cfg or resources/ folder.</div>
          ) : (
            <select
              value={draft.selectedProfile ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, selectedProfile: e.target.value }))}
            >
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="settings-divider" id="local-workspace-settings">Local workspace</div>
        <div className="setup-guide" role="note">
          <strong>{t("setup.guide.title")}</strong>
          <ol>
            <li>{t("setup.guide.workspace")}</li>
            <li>{t("setup.guide.endpoint")}</li>
            <li>{t("setup.guide.rcon")}</li>
            <li>{t("setup.guide.txAdmin")}</li>
            <li>{t("setup.guide.rescan")}</li>
          </ol>
          <strong>No server resource or separate MCP process is required.</strong> {" "}
          <a
            href="https://docs.fivem.net/docs/server-manual/setting-up-a-server-txadmin/"
            onClick={(e) => {
              e.preventDefault();
              void window.api.shell.openExternal("https://docs.fivem.net/docs/server-manual/setting-up-a-server-txadmin/");
            }}
          >
            Official txAdmin setup guide
          </a>
          .
        </div>
        <div className="field-hint" style={{ marginBottom: 6 }}>
          Create writes only <code>server.cfg</code>, <code>resources/[local]</code>, a gitignore, and a secrets example.
          txAdmin continues to own its separate control profile.
        </div>
        <div className="field-row" style={{ marginBottom: 6 }}>
          <input
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="workspace name"
            disabled={!draft.txDataPath || creatingWorkspace}
          />
          <input
            value={workspacePort}
            onChange={(e) => setWorkspacePort(e.target.value)}
            inputMode="numeric"
            placeholder="port"
            style={{ width: 90 }}
            disabled={!draft.txDataPath || creatingWorkspace}
          />
          <button className="btn" type="button" onClick={() => void createWorkspace()} disabled={!draft.txDataPath || creatingWorkspace}>
            {creatingWorkspace ? "Creating…" : "Create"}
          </button>
        </div>
        {workspaceMessage && <div className="field-hint" style={{ color: "var(--green)", marginBottom: 10 }}>{workspaceMessage}</div>}

        <div className="field-hint" style={{ marginBottom: 10 }}>
          The coding runtime is bundled, uses a fresh private token and ephemeral loopback port each launch, and is not configurable for remote servers.
        </div>

        <div className="settings-divider">Local server & client</div>

        <div className="field-row" style={{ marginBottom: 8 }}>
          <button className="btn" type="button" onClick={() => void autoDetect()} disabled={detectingExecutable !== null || artifactBusy !== null}>
            {detectingExecutable === "all" ? "Detecting…" : "Auto-detect all executables"}
          </button>
        </div>
        <div className="field-hint">
          Checks only conventional install folders and QB Studio artifact records. Custom locations always remain available through Browse; entire drives are never scanned.
        </div>

        <label className="field-label">Active Cfx.re target</label>
        <select
          value={draft.activeCfxTarget}
          onChange={(e) => setDraft((d) => ({ ...d, activeCfxTarget: e.target.value as CfxTarget }))}
          disabled={artifactBusy !== null}
        >
          <option value="legacy">FiveM — GTA V Legacy</option>
          <option value="enhanced">FiveM — GTA V Enhanced</option>
          <option value="redm">RedM — Red Dead Redemption 2</option>
        </select>
        <div className="field-hint">
          The top bar launches the client and server for this target. Every installation keeps its own client, server, and artifact state.
        </div>

        <div className="edition-path-grid">
          {CFX_TARGETS.map((target) => {
            const label = cfxTargetLabel(target);
            const serverPath = serverExeFor(draft, target);
            const clientPath = clientExeFor(draft, target);
            const clientExecutable = target === "redm" ? "RedM.exe" : "FiveM.exe";
            return (
              <section key={target} className={`edition-path-card ${activeTarget === target ? "active" : ""}`}>
                <h4>{label}</h4>
                <label className="field-label">Server artifact executable</label>
                <div className="field-row">
                  <input
                    value={serverPath ?? ""}
                    readOnly
                    placeholder={target === "enhanced" ? "cfx-server.exe" : "FXServer.exe"}
                  />
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void autoDetect(target, "server")}
                    disabled={detectingExecutable !== null || artifactBusy !== null}
                  >
                    {detectingExecutable === `${target}-server` ? "Detecting…" : "Auto"}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void pickFxServerExe(target)}
                    disabled={artifactBusy !== null}
                  >
                    Browse…
                  </button>
                </div>
                <label className="field-label">{target === "redm" ? "RedM" : "FiveM"} client executable</label>
                <div className="field-row">
                  <input value={clientPath ?? ""} readOnly placeholder={clientExecutable} />
                  <button className="btn" type="button" onClick={() => void autoDetect(target, "client")} disabled={detectingExecutable !== null || artifactBusy !== null}>
                    {detectingExecutable === `${target}-client` ? "Detecting…" : "Auto"}
                  </button>
                  <button className="btn" type="button" onClick={() => void pickExe(target)} disabled={artifactBusy !== null}>
                    Browse…
                  </button>
                </div>
                {clientPath && detectedClients[target] === clientPath && (
                  <div className="field-hint artifact-success">{t("setup.detected")}</div>
                )}
                {serverPath && detectedServers[target] === serverPath && (
                  <div className="field-hint artifact-success">Server executable auto-detected — confirm with Save & Connect.</div>
                )}
              </section>
            );
          })}
        </div>
        <div className="field-hint">
          Server paths enable <strong>Start server</strong>; client paths enable <strong>Launch client</strong>. QB Studio uses the selected
          txData workspace for the active target and prevents different configured server artifacts from being started together.
        </div>
        {activeTarget === "redm" && (
          <div className="field-hint" style={{ color: "var(--yellow)" }}>
            RedM server profiles require <code>set gamename rdr3</code> in server.cfg. Workspaces created while RedM is active include it automatically.
          </div>
        )}

        <label className="field-label">{cfxTargetLabel(activeTarget)} artifact update track</label>
        <div className="field-row artifact-controls">
          <select
            value={artifactTrack}
            onChange={(e) => {
              const track = e.target.value as "recommended" | "latest";
              setDraft((d) => activeTarget === "redm" ? { ...d, redmArtifactTrack: track } : { ...d, legacyArtifactTrack: track });
            }}
            disabled={activeTarget === "enhanced" || artifactBusy !== null}
            title={activeTarget === "enhanced" ? "Cfx.re currently publishes one Windows Enhanced artifact track." : undefined}
          >
            <option value="recommended">Recommended</option>
            <option value="latest">Latest (preview)</option>
          </select>
          <button
            className="btn"
            type="button"
            onClick={() => void checkArtifacts()}
            disabled={!serverPathIsSaved || artifactBusy !== null}
          >
            {artifactBusy === "checking" ? "Checking…" : "Check"}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => void updateArtifacts()}
            disabled={!serverPathIsSaved || !artifactStatus || artifactStatus.installedBuild === artifactStatus.build || artifactBusy !== null}
          >
            {artifactBusy === "updating" ? "Updating…" : "Install update"}
          </button>
        </div>
        {artifactBusy === "updating" && artifactProgress && (() => {
          const total = artifactProgress.totalBytes;
          const percent = total && total > 0
            ? Math.min(100, Math.round((artifactProgress.transferredBytes / total) * 100))
            : null;
          const formatBytes = (bytes: number) => bytes >= 1024 * 1024
            ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
            : `${Math.round(bytes / 1024)} KB`;
          return (
            <div className="artifact-progress" role="status" aria-live="polite">
              <div className="artifact-progress-copy">
                <strong>{t(`artifact.phase.${artifactProgress.phase}`)}</strong>
                <span>
                  {artifactProgress.phase === "downloading" && total
                    ? t("artifact.progress.bytes", {
                        percent: percent ?? 0,
                        transferred: formatBytes(artifactProgress.transferredBytes),
                        total: formatBytes(total),
                      })
                    : t("artifact.progress.working")}
                </span>
              </div>
              <progress max={100} value={percent ?? undefined} />
            </div>
          );
        })()}
        {!serverPathIsSaved && activeServerPath && (
          <div className="field-hint">Save Settings once before checking or installing artifacts for this path.</div>
        )}
        {artifactTrack === "latest" && activeTarget !== "enhanced" && (
          <div className="field-hint" style={{ color: "var(--yellow)" }}>
            Latest is newer, but Cfx.re has not marked it Recommended. Use it only when you need a recent server change.
          </div>
        )}
        {artifactStatus && (
          <div className="artifact-status" role="status">
            <strong>Cfx.re {artifactStatus.track} build {artifactStatus.build}</strong>
            <span>
              {artifactStatus.installedBuild === null
                ? "Installed build unknown (this installation has not yet been updated by QB Studio)."
                : artifactStatus.installedBuild === artifactStatus.build
                  ? "This managed build is installed."
                  : `QB Studio last installed build ${artifactStatus.installedBuild}.`}
            </span>
            <span>
              {artifactStatus.archiveSize ? `${(artifactStatus.archiveSize / 1024 / 1024).toFixed(1)} MB` : "Size unavailable"}
              {artifactStatus.publishedAt ? ` · ${new Date(artifactStatus.publishedAt).toLocaleDateString()}` : ""}
            </span>
          </div>
        )}
        {artifactError && <div className="error-text" role="alert">{artifactError}</div>}
        {artifactMessage && <div className="field-hint artifact-success">{artifactMessage}</div>}
        <div className="field-hint">
          Updates come from the {" "}
          <a
            href="https://docs.fivem.net/docs/server-download/"
            onClick={(e) => {
              e.preventDefault();
              void window.api.shell.openExternal("https://docs.fivem.net/docs/server-download/");
            }}
          >
            official Cfx.re server download page
          </a>
          . The archive is staged, path-checked, and CRC-checked before the artifact directory is swapped. Cfx.re does not publish a
          separate signature/checksum for these Windows artifacts. txData is never inside the update target.
        </div>

        <div className="settings-divider">Code editor</div>

        <label className="field-label">Lua intelligence</label>
        <select
          value={draft.editor.luaIntelligence}
          onChange={(e) => setDraft((d) => ({
            ...d,
            editor: {
              ...d.editor,
              luaIntelligence: e.target.value as StudioConfig["editor"]["luaIntelligence"],
            },
          }))}
        >
          <option value="balanced">Balanced — recommended</option>
          <option value="full">Full workspace</option>
          <option value="off">Off — syntax highlighting only</option>
        </select>
        <div className="field-hint">
          Balanced limits background indexing and diagnoses open files at full speed. The service runs only while a Lua tab is open; Full raises the file limits for unusually large frameworks.
        </div>

        <label className="field-label">Font size</label>
        <select
          value={draft.editor.fontSize}
          onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, fontSize: Number(e.target.value) } }))}
        >
          {[11, 12, 13, 14, 16, 18, 20, 22, 24].map((size) => (
            <option key={size} value={size}>{size}px</option>
          ))}
        </select>

        <label className="field-label">Word wrap</label>
        <select
          value={draft.editor.wordWrap ? "on" : "off"}
          onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, wordWrap: e.target.value === "on" } }))}
        >
          <option value="off">Off</option>
          <option value="on">On</option>
        </select>

        <div className="editor-settings-grid">
          <label className="field-label">
            Minimap
            <select
              value={draft.editor.minimap ? "on" : "off"}
              onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, minimap: e.target.value === "on" } }))}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </label>
          <label className="field-label">
            Sticky scroll
            <select
              value={draft.editor.stickyScroll ? "on" : "off"}
              onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, stickyScroll: e.target.value === "on" } }))}
            >
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="field-label">
            Format on save
            <select
              value={draft.editor.formatOnSave ? "on" : "off"}
              onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, formatOnSave: e.target.value === "on" } }))}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </label>
          <label className="field-label">
            {t("editor.restartAfterSave")}
            <select
              value={draft.editor.restartResourceOnSave ? "on" : "off"}
              onChange={(e) => setDraft((d) => ({
                ...d,
                editor: { ...d.editor, restartResourceOnSave: e.target.value === "on" },
              }))}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </label>
        </div>
        <div className="field-hint">
          Format on save runs only when the active language has a formatter. Editor models are kept only for open tabs so undo history survives tab switches without indexing closed files.
        </div>
        <div className="field-hint">{t("editor.restartAfterSaveHelp")}</div>

        <div className="settings-divider">Agent Chat</div>

        <label className="field-label">{t("agent.spendWarning")}</label>
        <select
          value={draft.agentSpendWarningUsd}
          onChange={(event) => setDraft((current) => ({ ...current, agentSpendWarningUsd: Number(event.target.value) }))}
        >
          <option value={0}>{t("agent.spendWarning.off")}</option>
          {[1, 2, 5, 10, 20].map((threshold) => (
            <option key={threshold} value={threshold}>${threshold.toFixed(2)}</option>
          ))}
        </select>
        <div className="field-hint">{t("agent.spendWarning.help")}</div>

        <label className="field-label">Provider</label>
        <div style={{ marginBottom: 6 }}>
          <select value={preset.id} onChange={(e) => applyPreset(e.target.value)}>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {COST_LABEL[p.cost]}
              </option>
            ))}
          </select>
        </div>
        <div className="field-hint">
          {preset.note}
          {preset.keyUrl && (
            <>
              {" "}
              <a
                href={preset.keyUrl}
                onClick={(e) => {
                  e.preventDefault();
                  window.api.shell.openExternal(preset.keyUrl!);
                }}
              >
                Get a key
              </a>
            </>
          )}
        </div>
        <div className="field-hint">
          <strong>The model must support tool calling.</strong> The agent works entirely through tools, so a model
          without solid tool support will connect fine and then just chat without ever touching your server.
        </div>
        <div className="field-hint">
          Hosted providers receive your messages, selected code, and tool results. Choose Ollama or LM Studio if model traffic must stay on this PC.
        </div>

        {isAnthropic ? (
          <>
            <label className="field-label">Anthropic API key{hasApiKey ? " — a key is saved" : ""}</label>
            <div className="field-row">
              <input
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                type="password"
                placeholder={hasApiKey ? "Saved — type here to replace it" : "sk-ant-…"}
              />
              {hasApiKey && (
                <button className="btn" onClick={clearApiKey}>
                  Clear
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <label className="field-label">Server URL</label>
            <input
              value={draft.openaiBaseUrl}
              onChange={(e) => setDraft((d) => ({ ...d, openaiBaseUrl: e.target.value }))}
              placeholder="https://…/v1"
            />

            <label className="field-label">Model</label>
            <div className="field-row">
              <input
                value={draft.openaiModel}
                onChange={(e) => setDraft((d) => ({ ...d, openaiModel: e.target.value }))}
                placeholder="model id"
                list="model-suggestions"
              />
              <button className="btn" onClick={loadModels} disabled={loadingModels}>
                {loadingModels ? "Loading…" : "Load models"}
              </button>
            </div>
            {models.length > 0 && (
              <datalist id="model-suggestions">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
            {modelsError && <div className="error-text">{modelsError}</div>}
            {models.length > 0 && (
              <div className="field-hint">
                {models.length} model{models.length === 1 ? "" : "s"} available — click the field for the list.
                {toolCapable && (() => {
                  const noTools = models.filter((m) => toolCapable[m] === false);
                  return noTools.length === 0 ? null : (
                    <>
                      <br />
                      <span style={{ color: "var(--yellow)" }}>
                        No tool support (unusable for the agent): {noTools.join(", ")}
                      </span>
                    </>
                  );
                })()}
              </div>
            )}
            {toolCapable?.[draft.openaiModel] === false && (
              <div className="error-text">
                “{draft.openaiModel}” doesn't support tool calling — the agent won't be able to do anything with it.
              </div>
            )}

            <label className="field-label">
              API key{preset.needsKey ? "" : " — not needed for a local server"}
              {hasLocalKey ? " (a key is saved)" : ""}
            </label>
            <div className="field-row">
              <input
                value={localKeyDraft}
                onChange={(e) => setLocalKeyDraft(e.target.value)}
                type="password"
                placeholder={
                  hasLocalKey ? "Saved — type here to replace it" : preset.needsKey ? "Paste your key" : "Leave blank"
                }
              />
              {hasLocalKey && (
                <button className="btn" onClick={clearLocalApiKey}>
                  Clear
                </button>
              )}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={operationBusy}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={operationBusy}>
            {busy ? "Connecting…" : "Save & Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
