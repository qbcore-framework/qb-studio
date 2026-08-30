import { useState, type KeyboardEvent } from "react";

import type { OpenFile } from "../App";
import { t } from "../i18n";
import {
  createEmptyManifestDataFile,
  manifestDataFileDraftsAreComplete,
  manifestPresenceFlagIsActive,
  normalizeManifestListDraft,
  parseManifestForm,
  SUPPORTED_FX_VERSIONS,
  SUPPORTED_NODE_VERSIONS,
  updateManifestForm,
  validateManifestFormValues,
  type ManifestDataFile,
  type ManifestFormValues,
  type ManifestListField,
  type ManifestScalarField,
} from "../../electron/manifestModel";

interface ManifestFormEditorProps {
  file: OpenFile;
  onChange: (path: string, content: string) => void;
  onSave: (path: string, content: string, expectedRevision: string) => Promise<void>;
}

const IDENTITY_FIELDS: Array<{ field: ManifestScalarField; label: string; placeholder: string }> = [
  { field: "fx_version", label: "fx_version", placeholder: "cerulean" },
  { field: "author", label: "author", placeholder: "QBCore Framework" },
  { field: "description", label: "description", placeholder: "What this resource does" },
  { field: "version", label: "version", placeholder: "1.0.0" },
];

const RUNTIME_FIELDS: Array<{ field: ManifestScalarField; label: string; placeholder: string }> = [
  { field: "ui_page", label: "ui_page", placeholder: "html/index.html" },
  { field: "loadscreen", label: "loadscreen", placeholder: "html/loadscreen.html" },
  { field: "replace_level_meta", label: "replace_level_meta", placeholder: "mymap" },
];

const OPTION_FIELDS: Array<{ field: ManifestScalarField; label: string }> = [
  { field: "this_is_a_map", label: "this_is_a_map" },
  { field: "server_only", label: "server_only" },
  { field: "loadscreen_manual_shutdown", label: "loadscreen_manual_shutdown" },
  { field: "loadscreen_cursor", label: "loadscreen_cursor" },
  { field: "use_experimental_fxv2_oal", label: "use_experimental_fxv2_oal" },
  { field: "clr_disable_task_scheduler", label: "clr_disable_task_scheduler" },
];

const LIST_GROUPS = [
  { field: "shared_scripts", rows: 4 },
  { field: "client_scripts", rows: 4 },
  { field: "server_scripts", rows: 4 },
  { field: "files", rows: 6 },
  { field: "dependencies", rows: 4 },
  { field: "escrow_ignore", rows: 4 },
  { field: "provides", rows: 3 },
  { field: "exports", rows: 3 },
  { field: "server_exports", rows: 3 },
] as const satisfies ReadonlyArray<{ field: ManifestListField; rows: number }>;

type ManifestTextListField = typeof LIST_GROUPS[number]["field"];
type ManifestListDrafts = Record<ManifestTextListField, string>;

const SERVER_ONLY_CLIENT_LIST_FIELDS = new Set<ManifestTextListField>([
  "shared_scripts",
  "client_scripts",
  "files",
  "exports",
]);

function listDraftsFromValues(values: ManifestFormValues): ManifestListDrafts {
  return Object.fromEntries(
    LIST_GROUPS.map(({ field }) => [field, values[field].join("\n")]),
  ) as ManifestListDrafts;
}

function valuesWithListDrafts(
  values: ManifestFormValues,
  drafts: ManifestListDrafts,
): ManifestFormValues {
  const next = { ...values };
  for (const { field } of LIST_GROUPS) {
    next[field] = normalizeManifestListDraft(drafts[field]);
  }
  return next;
}

function sameDataFileDrafts(left: ManifestDataFile[], right: ManifestDataFile[]): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.type === right[index]?.type && entry.path === right[index]?.path,
  );
}

export default function ManifestFormEditor({ file, onChange, onSave }: ManifestFormEditorProps) {
  const parsed = parseManifestForm(file.content);
  if (!parsed.ok) return <div className="manifest-form-error">{parsed.reason}</div>;

  return (
    <ManifestFormFields
      key={`${file.path}\u0000${file.revision}`}
      file={file}
      values={parsed.values}
      onChange={onChange}
      onSave={onSave}
    />
  );
}

function ManifestFormFields({
  file,
  values,
  onChange,
  onSave,
}: ManifestFormEditorProps & { values: ManifestFormValues }) {
  const [listDrafts, setListDrafts] = useState<ManifestListDrafts>(
    () => listDraftsFromValues(values),
  );
  const [dataFileDrafts, setDataFileDrafts] = useState<ManifestDataFile[]>(() => values.data_files);
  const valuesForValidation = {
    ...valuesWithListDrafts(values, listDrafts),
    data_files: dataFileDrafts,
  };
  const validationIssues = validateManifestFormValues(valuesForValidation);
  const contentWithDrafts = updateManifestForm(file.content, valuesForValidation);
  const hasUncommittedDrafts = contentWithDrafts !== file.content ||
    !sameDataFileDrafts(dataFileDrafts, values.data_files);
  const issueSet = new Set(validationIssues);
  const normalizedNodeVersion = values.node_version.trim();

  function apply(next: ManifestFormValues) {
    const nextContent = updateManifestForm(file.content, next);
    if (nextContent !== file.content) onChange(file.path, nextContent);
  }

  function updateListDraft(field: ManifestTextListField, draft: string) {
    setListDrafts((current) => ({ ...current, [field]: draft }));
    apply({ ...values, [field]: normalizeManifestListDraft(draft) });
  }

  function updateDataFileDrafts(next: ManifestDataFile[]) {
    setDataFileDrafts(next);
    if (manifestDataFileDraftsAreComplete(next)) {
      apply({ ...values, data_files: next });
    }
  }

  function save(event?: KeyboardEvent<HTMLDivElement>) {
    if (event && ((!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "s")) return;
    event?.preventDefault();
    const normalizedValues = valuesWithListDrafts(values, listDrafts);
    normalizedValues.data_files = dataFileDrafts;
    if (validateManifestFormValues(normalizedValues).length > 0) return;
    const normalizedContent = updateManifestForm(file.content, normalizedValues);
    setListDrafts(listDraftsFromValues(normalizedValues));
    if (normalizedContent !== file.content) onChange(file.path, normalizedContent);
    void onSave(file.path, normalizedContent, file.revision).catch(() => {
      // App owns the visible conflict/error status.
    });
  }

  function toggleGame(game: "common" | "gta5" | "rdr3", checked: boolean) {
    let games = values.games.filter((value) => value.toLowerCase() !== game);
    if (checked) games = game === "common"
      ? ["common"]
      : [...games.filter((value) => value.toLowerCase() !== "common"), game];
    apply({ ...values, games });
  }

  return (
    <div className="manifest-form" onKeyDown={save}>
      <div className="manifest-form-header">
        <div>
          <strong>{t("manifest.title")}</strong>
          <span>{t("manifest.preserveHelp")}</span>
        </div>
        <button
          type="button"
          className="btn small primary"
          disabled={(!file.dirty && !hasUncommittedDrafts) || validationIssues.length > 0}
          onClick={() => save()}
        >
          {file.dirty || hasUncommittedDrafts ? t("manifest.save") : t("manifest.saved")}
        </button>
      </div>
      <div className="manifest-form-body">
        {validationIssues.length > 0 && (
          <div className="manifest-validation-errors" role="alert">
            <strong>{t("manifest.validationTitle")}</strong>
            <ul>
              {validationIssues.map((issue) => <li key={issue}>{t(`manifest.validation.${issue}`)}</li>)}
            </ul>
          </div>
        )}
        <section className="manifest-form-section">
          <h3>{t("manifest.identity")}</h3>
          <div className="manifest-scalar-grid">
            {IDENTITY_FIELDS.map(({ field, label, placeholder }) => {
              const unknownFxVersion = field === "fx_version" && Boolean(values.fx_version) &&
                !SUPPORTED_FX_VERSIONS.includes(values.fx_version as typeof SUPPORTED_FX_VERSIONS[number]);
              return (
                <label key={field}>
                  <span>{label}</span>
                  {field === "fx_version" ? (
                    <select
                      value={values.fx_version}
                      aria-invalid={issueSet.has("fx_version") || undefined}
                      onChange={(event) => apply({ ...values, fx_version: event.target.value })}
                    >
                      <option value="">{t("manifest.fxVersionChoose")}</option>
                      {unknownFxVersion && (
                        <option value={values.fx_version}>{t("manifest.fxVersionUnsupported", { value: values.fx_version })}</option>
                      )}
                      {SUPPORTED_FX_VERSIONS.map((version) => (
                        <option key={version} value={version}>{version}{version === "cerulean" ? ` — ${t("manifest.current")}` : ""}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={values[field]}
                      placeholder={placeholder}
                      onChange={(event) => apply({ ...values, [field]: event.target.value })}
                    />
                  )}
                </label>
              );
            })}
          </div>
          <fieldset className="manifest-check-grid manifest-game-options" aria-invalid={issueSet.has("games") || undefined}>
            <legend>{t("manifest.games")}</legend>
            {(["common", "gta5", "rdr3"] as const).map((game) => (
              <label key={game} className="manifest-check-option">
                <input
                  type="checkbox"
                  checked={values.games.some((value) => value.toLowerCase() === game)}
                  onChange={(event) => toggleGame(game, event.currentTarget.checked)}
                />
                <span>{game}</span>
              </label>
            ))}
          </fieldset>
        </section>

        <section className="manifest-form-section">
          <h3>{t("manifest.scriptLists")}</h3>
          <div className="manifest-list-grid">
            {LIST_GROUPS.slice(0, 3).map(({ field, rows }) => (
              <label key={field}>
                <span>{field}</span>
                <textarea
                  rows={rows}
                  value={listDrafts[field]}
                  placeholder={t("manifest.onePerLine")}
                  aria-invalid={issueSet.has("server_only_conflict") &&
                    SERVER_ONLY_CLIENT_LIST_FIELDS.has(field) && Boolean(listDrafts[field].trim()) || undefined}
                  onChange={(event) => updateListDraft(field, event.target.value)}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="manifest-form-section">
          <h3>{t("manifest.nuiRuntime")}</h3>
          <div className="manifest-scalar-grid">
            {RUNTIME_FIELDS.map(({ field, label, placeholder }) => {
              const invalid = (field === "ui_page" && issueSet.has("ui_page_file")) ||
                (field === "loadscreen" && issueSet.has("loadscreen_file")) ||
                (field === "replace_level_meta" && issueSet.has("replace_level_meta_file")) ||
                (issueSet.has("server_only_conflict") && Boolean(values[field].trim()));
              return (
                <label key={field}>
                  <span>{label}</span>
                  <input
                    value={values[field]}
                    placeholder={placeholder}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => apply({ ...values, [field]: event.target.value })}
                  />
                </label>
              );
            })}
            <label>
              <span>node_version</span>
              <select
                value={normalizedNodeVersion}
                aria-invalid={issueSet.has("node_version") || undefined}
                onChange={(event) => apply({ ...values, node_version: event.target.value })}
              >
                <option value="">{t("manifest.nodeVersionDefault")}</option>
                {normalizedNodeVersion && !SUPPORTED_NODE_VERSIONS.includes(
                  normalizedNodeVersion as typeof SUPPORTED_NODE_VERSIONS[number],
                ) && (
                  <option value={normalizedNodeVersion}>
                    {t("manifest.nodeVersionUnsupported", { value: normalizedNodeVersion })}
                  </option>
                )}
                {SUPPORTED_NODE_VERSIONS.map((version) => (
                  <option key={version} value={version}>{version}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="manifest-form-section">
          <h3>{t("manifest.packfiles")}</h3>
          <div className="manifest-list-grid">
            {LIST_GROUPS.slice(3).map(({ field, rows }) => (
              <label key={field}>
                <span>{field}</span>
                <textarea
                  rows={rows}
                  value={listDrafts[field]}
                  placeholder={t("manifest.onePerLine")}
                  aria-invalid={(issueSet.has("server_only_conflict") &&
                    SERVER_ONLY_CLIENT_LIST_FIELDS.has(field) && Boolean(listDrafts[field].trim())) || undefined}
                  onChange={(event) => updateListDraft(field, event.target.value)}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="manifest-form-section">
          <div className="manifest-section-heading">
            <h3>{t("manifest.dataFiles")}</h3>
            <button
              type="button"
              className="btn small"
              onClick={() => setDataFileDrafts((current) => [...current, createEmptyManifestDataFile()])}
            >
              {t("manifest.addDataFile")}
            </button>
          </div>
          {dataFileDrafts.length === 0
            ? <p className="manifest-empty-help">{t("manifest.noDataFiles")}</p>
            : <div className="manifest-data-files">
                {dataFileDrafts.map((entry, index) => (
                  <div className="manifest-data-file" key={index}>
                    <label>
                      <span>{t("manifest.dataFileType")}</span>
                      <input
                        value={entry.type}
                        aria-invalid={!entry.type.trim() || issueSet.has("server_only_conflict") || undefined}
                        onChange={(event) => updateDataFileDrafts(
                          dataFileDrafts.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, type: event.target.value } : item,
                          ),
                        )}
                      />
                    </label>
                    <label>
                      <span>{t("manifest.dataFilePath")}</span>
                      <input
                        value={entry.path}
                        aria-invalid={!entry.path.trim() || issueSet.has("server_only_conflict") || undefined}
                        onChange={(event) => updateDataFileDrafts(
                          dataFileDrafts.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, path: event.target.value } : item,
                          ),
                        )}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn small danger"
                      aria-label={t("manifest.removeDataFile", { index: index + 1 })}
                      onClick={() => updateDataFileDrafts(
                        dataFileDrafts.filter((_, itemIndex) => itemIndex !== index),
                      )}
                    >
                      {t("manifest.remove")}
                    </button>
                  </div>
                ))}
              </div>}
        </section>

        <section className="manifest-form-section">
          <h3>{t("manifest.options")}</h3>
          <div className="manifest-check-grid">
            {OPTION_FIELDS.map(({ field, label }) => (
              <label key={field} className="manifest-check-option">
                <input
                  type="checkbox"
                  checked={manifestPresenceFlagIsActive(values[field])}
                  aria-invalid={(field === "server_only" && issueSet.has("server_only_conflict")) || undefined}
                  aria-describedby={field === "use_experimental_fxv2_oal" ? "manifest-oal-warning" : undefined}
                  onChange={(event) => apply({ ...values, [field]: event.currentTarget.checked ? "yes" : "" })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <p id="manifest-oal-warning" className="manifest-empty-help">
            {t("manifest.oalWarning")}
          </p>
          <p className="manifest-empty-help">{t("manifest.rawAdvancedHelp")}</p>
        </section>
      </div>
    </div>
  );
}
