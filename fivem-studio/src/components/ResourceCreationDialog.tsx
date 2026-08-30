import { type FormEvent, useId, useState } from "react";

import { useDialogFocus } from "../hooks/useDialogFocus";
import { t } from "../i18n";

export type ResourceCreationKind = "file" | "folder" | "resource";
export type StarterResourceTemplate = "lua" | "static-nui" | "react-nui" | "vue-nui";

interface ResourceCreationDialogProps {
  kind: ResourceCreationKind;
  parentPath: string;
  onCreate: (name: string, template: StarterResourceTemplate) => Promise<void>;
  onClose: () => void;
}

export default function ResourceCreationDialog({
  kind,
  parentPath,
  onCreate,
  onClose,
}: ResourceCreationDialogProps) {
  const initialName = t(`resource.create.namePlaceholder.${kind}`);
  const [name, setName] = useState(initialName);
  const [template, setTemplate] = useState<StarterResourceTemplate>("lua");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const errorId = useId();
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose, !busy);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const proposed = name.trim();
    if (!proposed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(proposed, template);
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(t(`resource.create.failure.${kind}`, { message }));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (!busy && event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className="modal resource-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <form className="resource-create-form" onSubmit={(event) => void submit(event)}>
          <h3 id={titleId}>{t(`resource.create.title.${kind}`)}</h3>
          <p className="resource-create-target">{t("resource.create.target", { target: parentPath })}</p>
          <div className="resource-create-field">
            <label htmlFor={`${titleId}-name`}>{t("resource.create.nameLabel")}</label>
            <input
              id={`${titleId}-name`}
              data-dialog-initial-focus
              value={name}
              disabled={busy}
              required
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? errorId : undefined}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setError(null);
              }}
            />
          </div>
          {kind === "resource" && (
            <fieldset className="resource-template-options">
              <legend>{t("resource.create.templateLabel")}</legend>
              {(["lua", "static-nui", "react-nui", "vue-nui"] as const).map((option) => (
                <label key={option} className="resource-template-option">
                  <input
                    type="radio"
                    name={`${titleId}-template`}
                    value={option}
                    checked={template === option}
                    disabled={busy}
                    onChange={() => setTemplate(option)}
                  />
                  <span>
                    <strong>{t(`resource.create.template.${option}.name`)}</strong>
                    <small>{t(`resource.create.template.${option}.help`)}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {error && <p id={errorId} className="resource-create-error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              {t("resource.create.cancel")}
            </button>
            <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
              {busy ? t("resource.create.creating") : t("resource.create.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
