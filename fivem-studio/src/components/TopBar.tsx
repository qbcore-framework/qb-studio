import type { CfxTarget, RecentWorkspaceSummary, RuntimeIdentity, RuntimeWorkspaceMatch } from "../global";
import { t } from "../i18n";

interface TopBarProps {
  appVersion: string;
  connected: boolean;
  runtimeIdentity: RuntimeIdentity | null;
  workspaceMatch: RuntimeWorkspaceMatch | null;
  onOpenSettings: () => void;
  onLaunchServer: () => void;
  onStopServer: () => void;
  onRestartServer: () => void;
  onLaunchClient: () => void;
  onOpenWorkspace: () => void;
  activeTarget: CfxTarget;
  serverTarget: CfxTarget;
  activeServerPath: string | null;
  serverConfigured: boolean;
  serverAction: "starting" | "stopping" | "restarting" | null;
  serverRunning: boolean;
  serverPids: number[];
  serverStartedAt: number | null;
  serverStatusError: string | null;
  activeClientPath: string | null;
  workspacePath: string | null;
  recentWorkspaces: RecentWorkspaceSummary[];
  onSelectRecentWorkspace: (id: string) => void;
}

export default function TopBar({
  appVersion,
  connected,
  runtimeIdentity,
  workspaceMatch,
  onOpenSettings,
  onLaunchServer,
  onStopServer,
  onRestartServer,
  onLaunchClient,
  onOpenWorkspace,
  activeTarget,
  serverTarget,
  activeServerPath,
  serverConfigured,
  serverAction,
  serverRunning,
  serverPids,
  serverStartedAt,
  serverStatusError,
  activeClientPath,
  workspacePath,
  recentWorkspaces,
  onSelectRecentWorkspace,
}: TopBarProps) {
  const labelFor = (target: CfxTarget) => target === "legacy" ? "FiveM Legacy" : target === "enhanced" ? "FiveM Enhanced" : "RedM";
  const activeLabel = labelFor(activeTarget);
  const serverLabel = labelFor(serverTarget);
  const clientExecutable = activeTarget === "redm" ? "RedM.exe" : "FiveM.exe";
  const runtimeReady = connected && workspaceMatch?.ok === true;
  const statusLabel = !connected
    ? "Coding runtime unavailable"
    : runtimeReady
      ? "Coding runtime ready"
      : "Coding runtime ready · read only";
  const availabilityNote = "The coding runtime does not confirm that FXServer is running.";
  const uptime = serverStartedAt === null
    ? "just observed"
    : (() => {
        const seconds = Math.max(0, Math.floor((Date.now() - serverStartedAt) / 1000));
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
      })();
  const statusTitle = !connected
    ? "QB Studio could not reach its bundled coding runtime."
    : `${workspaceMatch?.reason ?? (runtimeIdentity ? `${runtimeIdentity.mcp.name} ${runtimeIdentity.mcp.version}` : "Bundled coding runtime")}. ${availabilityNote}`;
  const serverButtonLabel = serverAction === "starting"
    ? "Starting server"
    : serverAction === "stopping"
      ? "Stopping server"
      : serverRunning
        ? `Stop ${serverLabel} server`
        : `Start ${activeLabel} server`;
  return (
    <div className="topbar">
      <span className="brand">
        <span>QB Studio</span>
        <span className="brand-version" title={`QB Studio version ${appVersion}`}>v{appVersion}</span>
      </span>
      <div className="spacer" />
      <div className="status-pill runtime-status" title={statusTitle}>
        <span className={`status-dot ${runtimeReady ? "connected" : connected ? "limited" : "disconnected"}`} />
        {statusLabel}
      </div>
      <div
        className={`status-pill server-status ${serverStatusError ? "error" : serverRunning ? "running" : "stopped"}`}
        title={serverStatusError ?? (serverPids.length ? `Local process ${serverPids.join(", ")}` : undefined)}
      >
        <span className={`status-dot ${serverStatusError ? "disconnected" : serverRunning ? "connected" : "limited"}`} />
        {serverStatusError
          ? t("server.status.unknown")
          : serverRunning
            ? t("server.status.running", { server: serverLabel, uptime })
            : t("server.status.stopped", { server: activeLabel })}
      </div>
      <button
        className="btn topbar-action"
        aria-label={serverButtonLabel}
        onClick={serverRunning ? onStopServer : onLaunchServer}
        disabled={serverAction !== null || (!serverRunning && (!activeServerPath || !serverConfigured))}
        title={
          serverStatusError
            ? `Server status unavailable: ${serverStatusError}`
            : serverRunning
              ? `Stop the ${serverLabel} local server${serverPids.length ? ` (process ${serverPids.join(", ")})` : ""}`
            : !activeServerPath
            ? `Set the ${activeLabel} server executable in Settings`
            : !serverConfigured
              ? "Choose a txData workspace in Settings"
              : activeServerPath
        }
      >
        <span className="topbar-label">
          {serverAction === "starting" || serverAction === "stopping" ? `${serverButtonLabel}…` : `${serverRunning ? "■" : "▶"} ${serverButtonLabel}`}
        </span>
        <span className="topbar-compact" aria-hidden="true">
          {serverAction ? "…" : serverRunning ? "■" : "▶"}
        </span>
      </button>
      {(serverRunning || serverAction === "restarting") && (
        <button
          className="btn topbar-action"
          aria-label={serverAction === "restarting" ? `Restarting ${serverLabel} server` : `Restart ${serverLabel} server`}
          onClick={onRestartServer}
          disabled={serverAction !== null}
          title={
            serverStatusError
              ? `Server status unavailable: ${serverStatusError}`
              : `Stop and restart the ${serverLabel} local server`
          }
        >
          <span className="topbar-label">
            {serverAction === "restarting" ? `Restarting ${serverLabel} server…` : `↻ Restart ${serverLabel} server`}
          </span>
          <span className="topbar-compact" aria-hidden="true">{serverAction === "restarting" ? "…" : "↻"}</span>
        </button>
      )}
      <button className="btn topbar-action" aria-label={`Launch ${activeLabel}`} onClick={onLaunchClient} disabled={!activeClientPath} title={activeClientPath ?? `Set the ${activeLabel} ${clientExecutable} path in Settings`}>
        <span className="topbar-label">▶ Launch {activeLabel}</span>
        <span className="topbar-compact" aria-hidden="true">▶ C</span>
      </button>
      <button className="btn topbar-action" aria-label={t("workspace.open")} onClick={onOpenWorkspace} disabled={!workspacePath} title={workspacePath ?? t("workspace.choose")}>
        <span className="topbar-label">{t("workspace.open")}</span>
        <span className="topbar-compact" aria-hidden="true">⌂</span>
      </button>
      <select
        className="topbar-workspaces"
        aria-label={t("workspace.recent")}
        value=""
        onChange={(event) => event.target.value && onSelectRecentWorkspace(event.target.value)}
        disabled={recentWorkspaces.length === 0}
      >
        <option value="">{t("workspace.recentPlaceholder")}</option>
        {recentWorkspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>{workspace.label} · {labelFor(workspace.target)}</option>
        ))}
      </select>
      <button className="btn topbar-action" aria-label="Settings" onClick={onOpenSettings} title="Settings">
        <span className="topbar-label">⚙ Settings</span>
        <span className="topbar-compact" aria-hidden="true">⚙</span>
      </button>
    </div>
  );
}
