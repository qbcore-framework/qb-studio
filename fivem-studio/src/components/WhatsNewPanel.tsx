import { t } from "../i18n";
import { useDialogFocus } from "../hooks/useDialogFocus";

export default function WhatsNewPanel({ currentVersion, onClose }: { currentVersion: string; onClose: () => void }) {
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  return (
    <div className="modal-backdrop whats-new-backdrop" onClick={onClose}>
      <section ref={dialogRef} className="whats-new-panel" role="dialog" aria-modal="true" aria-labelledby="whats-new-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="whats-new-brand" aria-hidden="true">QB</div>
        <div>
          <h2 id="whats-new-title" data-dialog-initial-focus tabIndex={-1}>{t("whatsNew.title", { version: currentVersion })}</h2>
          <p>{t("whatsNew.intro")}</p>
          <ul>
            <li>{t("whatsNew.resourceCreation")}</li>
            <li>{t("whatsNew.creationSafety")}</li>
            <li>{t("whatsNew.consoleSources")}</li>
            <li>{t("whatsNew.agentFix")}</li>
            <li>{t("whatsNew.agentConnections")}</li>
          </ul>
          <div className="modal-actions">
            <button type="button" className="btn primary" onClick={onClose}>{t("whatsNew.continue")}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
