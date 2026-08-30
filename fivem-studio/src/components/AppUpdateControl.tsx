import { useEffect, useState } from "react";
import type { AppUpdateState } from "../global";
import { t } from "../i18n";

interface AppUpdateControlProps {
  state: AppUpdateState;
  onCheck: () => void | Promise<void>;
  onDownload: () => void | Promise<void>;
  onRestart: () => void | Promise<void>;
  busy?: boolean;
  restartBlockedReason?: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export default function AppUpdateControl({
  state,
  onCheck,
  onDownload,
  onRestart,
  busy = false,
  restartBlockedReason = null,
}: AppUpdateControlProps) {
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const targetVersion = state.latestVersion ?? state.currentVersion;
  const progress = state.progressPercent === null || !Number.isFinite(state.progressPercent)
    ? null
    : Math.max(0, Math.min(100, Math.round(state.progressPercent)));
  const transferred = state.transferredBytes === null || !Number.isFinite(state.transferredBytes)
    ? null
    : formatBytes(Math.max(0, state.transferredBytes));
  const total = state.totalBytes === null || !Number.isFinite(state.totalBytes)
    ? null
    : formatBytes(Math.max(0, state.totalBytes));

  const stateMessage = state.phase === "disabled"
    ? t("appUpdate.disabled")
    : state.phase === "checking"
      ? t("appUpdate.checking")
      : state.phase === "up-to-date"
        ? t("appUpdate.upToDate")
        : state.phase === "available"
          ? t("appUpdate.available", { version: targetVersion })
          : state.phase === "downloading"
            ? progress === null
              ? t("appUpdate.downloading")
              : t("appUpdate.downloadingPercent", { percent: progress })
            : state.phase === "ready"
              ? t("appUpdate.ready", { version: targetVersion })
              : state.phase === "error"
                ? state.error || t("appUpdate.error")
                : t("appUpdate.idle");
  const message = actionError ?? stateMessage;
  const hasError = state.phase === "error" || actionError !== null;

  useEffect(() => setActionError(null), [state.phase, state.latestVersion]);

  const working = busy || actionBusy || state.phase === "checking" || state.phase === "downloading";
  const action = state.phase === "available"
    ? {
        label: t("appUpdate.download"),
        ariaLabel: t("appUpdate.downloadVersion", { version: targetVersion }),
        onClick: onDownload,
        primary: true,
      }
    : state.phase === "ready"
      ? {
          label: t("appUpdate.restart"),
          ariaLabel: t("appUpdate.restartVersion", { version: targetVersion }),
          onClick: onRestart,
          primary: true,
        }
      : state.phase === "checking"
        ? {
            label: t("appUpdate.checkingAction"),
            ariaLabel: t("appUpdate.checkingAction"),
            onClick: onCheck,
            primary: false,
          }
        : state.phase === "downloading"
          ? {
              label: t("appUpdate.downloadingAction"),
              ariaLabel: t("appUpdate.downloadingAction"),
              onClick: onDownload,
              primary: false,
            }
          : state.phase === "disabled"
            ? null
            : {
                label: state.phase === "error" ? t("appUpdate.retry") : t("appUpdate.check"),
                ariaLabel: state.phase === "error" ? t("appUpdate.retry") : t("appUpdate.check"),
                onClick: onCheck,
                primary: false,
              };

  const runAction = async (callback: () => void | Promise<void>) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await callback();
    } catch (error) {
      setActionError((error as Error).message || t("appUpdate.error"));
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <section
      className={`app-update-card ${hasError ? "error" : ""}`}
      aria-labelledby="app-update-title"
      aria-busy={working}
    >
      <div className="app-update-summary">
        <div>
          <h4 id="app-update-title">QB Studio</h4>
          <div className="app-update-version">{t("appUpdate.version", { version: state.currentVersion })}</div>
        </div>
        {action && (
          <button
            type="button"
            className={`btn app-update-action ${action.primary ? "primary" : ""}`}
            aria-label={action.ariaLabel}
            onClick={() => void runAction(action.onClick)}
            disabled={working || (state.phase === "ready" && restartBlockedReason !== null)}
          >
            {action.label}
          </button>
        )}
      </div>

      <div
        className="app-update-message"
        role={hasError ? "alert" : "status"}
        aria-live={hasError ? "assertive" : "polite"}
      >
        {state.phase === "downloading" && actionError === null ? (
          <>
            <span aria-hidden="true">{message}</span>
            <span className="sr-only">{t("appUpdate.downloading")}</span>
          </>
        ) : message}
      </div>

      {state.phase === "downloading" && (
        <div className="app-update-progress">
          <progress
            max={100}
            value={progress ?? undefined}
            aria-label={t("appUpdate.downloadProgress", { version: targetVersion })}
          />
          {(transferred || total) && (
            <span aria-hidden="true">
              {transferred && total
                ? t("appUpdate.downloadBytes", { transferred, total })
                : transferred ?? total}
            </span>
          )}
        </div>
      )}

      {state.phase === "ready" && (
        <div className="app-update-hint">{restartBlockedReason ?? t("appUpdate.restartHelp")}</div>
      )}

      {hasError && state.releaseUrl && (
        <button
          type="button"
          className="app-update-release-link"
          onClick={() => void runAction(() => window.api.shell.openExternal(state.releaseUrl!))}
          disabled={working}
        >
          {t("appUpdate.viewRelease")}
        </button>
      )}
    </section>
  );
}
