import { useCallback, useEffect, useState } from "preact/hooks";
import { CATALYST_STATUS_LABELS, CATALYST_TYPE_LABELS, formatCatalystDate, isIsoDate } from "../../../shared/catalysts";
import { allCompanies } from "../../../shared/config";
import type { AdminCatalyst, CatalystInput, CatalystStatus, CatalystType } from "../../../shared/types";
import { ApiError, type Api } from "../api";

type Form = Record<keyof CatalystInput, string>;
const EMPTY: Form = { ticker: "", program: "", indication: "", eventType: "", dateStart: "", dateEnd: "", status: "", nctId: "", sourceUrl: "", sourceName: "", notes: "" };

const toForm = (c: AdminCatalyst): Form => ({
  ticker: c.ticker, program: c.program, indication: c.indication ?? "", eventType: c.eventType, dateStart: c.dateStart, dateEnd: c.dateEnd ?? "",
  status: c.status, nctId: c.nctId ?? "", sourceUrl: c.sourceUrl ?? "", sourceName: c.sourceName ?? "", notes: c.notes ?? "",
});

/** Mirrors the server rules so mistakes show before a round trip; the server remains the authority. */
export function validateForm(f: Form): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!f.ticker) errors.ticker = "Required";
  if (!f.program.trim()) errors.program = "Required";
  if (!f.eventType) errors.eventType = "Required";
  if (!f.status) errors.status = "Required";
  if (!f.dateStart) errors.dateStart = "Required";
  else if (!isIsoDate(f.dateStart)) errors.dateStart = "Use a real date in YYYY-MM-DD format";
  if (f.dateEnd && !isIsoDate(f.dateEnd)) errors.dateEnd = "Use a real date in YYYY-MM-DD format";
  else if (f.dateEnd && f.dateStart && f.dateEnd < f.dateStart) errors.dateEnd = "End date cannot be before the start date";
  if (f.nctId && !/^NCT\d{8}$/.test(f.nctId.trim())) errors.nctId = "Format: NCT followed by 8 digits";
  return errors;
}

function Field({ id, label, error, required, children }: { id: string; label: string; error?: string; required?: boolean; children: preact.ComponentChildren }) {
  return (
    <div class="bt-field">
      <label for={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children}
      {error && (
        <span class="bt-field__error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function CatalystAdmin({ api }: { api: Api }) {
  const [items, setItems] = useState<AdminCatalyst[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api.adminCatalysts()).items);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [api]);

  useEffect(() => void load(), [load]);

  const set = (key: keyof Form) => (e: Event) => setForm({ ...form, [key]: (e.target as HTMLInputElement).value });
  const reset = () => (setForm(EMPTY), setEditingId(null), setErrors({}));
  const describe = (id: string) => (errors[id] ? { "aria-invalid": true, "aria-describedby": `bt-f-${id}-error` } : {});

  const failure = (err: unknown, action: string) => {
    const status = err instanceof ApiError ? err.status : null;
    if (err instanceof ApiError && err.fields) setErrors(err.fields);
    setMessage(status === 401 ? "Session expired. Sign in again." : status === 400 ? "Please correct the highlighted fields." : `${action} failed. Nothing was saved.`);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const found = validateForm(form);
    setErrors(found);
    setMessage(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const input = form as unknown as CatalystInput;
      if (editingId) await api.updateCatalyst(editingId, input);
      else await api.createCatalyst(input);
      setMessage(editingId ? "Entry updated." : "Entry added.");
      reset();
      await load();
    } catch (err) {
      failure(err, "Save");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: AdminCatalyst) => {
    if (!window.confirm(`Delete ${c.ticker} ${c.program} (${c.dateStart})?`)) return;
    setMessage(null);
    try {
      await api.deleteCatalyst(c.id);
      if (editingId === c.id) reset();
      setMessage("Entry deleted.");
      await load();
    } catch (err) {
      failure(err, "Delete");
    }
  };

  const manual = (items ?? []).filter((c) => c.origin === "manual");
  const registryCount = (items ?? []).length - manual.length;

  return (
    <div class="bt-admin-section">
      <h3 class="bt-subhead">{editingId ? "Edit catalyst" : "Add catalyst"}</h3>
      <form class="bt-form" onSubmit={submit} noValidate aria-label="Catalyst entry">
        <Field id="bt-f-ticker" label="Company" error={errors.ticker} required>
          <select id="bt-f-ticker" value={form.ticker} onChange={set("ticker")} {...describe("ticker")}>
            <option value="">Select…</option>
            {allCompanies().map((c) => (
              <option key={c.ticker} value={c.ticker}>
                {c.ticker} — {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="bt-f-eventType" label="Event type" error={errors.eventType} required>
          <select id="bt-f-eventType" value={form.eventType} onChange={set("eventType")} {...describe("eventType")}>
            <option value="">Select…</option>
            {(Object.keys(CATALYST_TYPE_LABELS) as CatalystType[]).map((t) => (
              <option key={t} value={t}>
                {CATALYST_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="bt-f-program" label="Drug or programme" error={errors.program} required>
          <input id="bt-f-program" type="text" maxLength={200} value={form.program} onInput={set("program")} {...describe("program")} />
        </Field>
        <Field id="bt-f-indication" label="Indication" error={errors.indication}>
          <input id="bt-f-indication" type="text" maxLength={300} value={form.indication} onInput={set("indication")} {...describe("indication")} />
        </Field>
        <Field id="bt-f-dateStart" label="Date (or range start)" error={errors.dateStart} required>
          <input id="bt-f-dateStart" type="date" value={form.dateStart} onInput={set("dateStart")} {...describe("dateStart")} />
        </Field>
        <Field id="bt-f-dateEnd" label="Range end (optional)" error={errors.dateEnd}>
          <input id="bt-f-dateEnd" type="date" value={form.dateEnd} onInput={set("dateEnd")} {...describe("dateEnd")} />
        </Field>
        <Field id="bt-f-status" label="Verification status" error={errors.status} required>
          <select id="bt-f-status" value={form.status} onChange={set("status")} {...describe("status")}>
            <option value="">Select…</option>
            {(Object.keys(CATALYST_STATUS_LABELS) as CatalystStatus[]).map((s) => (
              <option key={s} value={s}>
                {CATALYST_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="bt-f-nctId" label="NCT number (overrides registry estimate)" error={errors.nctId}>
          <input id="bt-f-nctId" type="text" placeholder="NCT01234567" value={form.nctId} onInput={set("nctId")} {...describe("nctId")} />
        </Field>
        <Field id="bt-f-sourceUrl" label="Source URL" error={errors.sourceUrl}>
          <input id="bt-f-sourceUrl" type="url" placeholder="https://" value={form.sourceUrl} onInput={set("sourceUrl")} {...describe("sourceUrl")} />
        </Field>
        <Field id="bt-f-sourceName" label="Source name" error={errors.sourceName}>
          <input id="bt-f-sourceName" type="text" maxLength={120} value={form.sourceName} onInput={set("sourceName")} {...describe("sourceName")} />
        </Field>
        <Field id="bt-f-notes" label="Notes (admin only, never shown publicly)" error={errors.notes}>
          <textarea id="bt-f-notes" rows={2} maxLength={2000} value={form.notes} onInput={set("notes")} {...describe("notes")} />
        </Field>
        <div class="bt-form__actions">
          <button type="submit" class="bt-chip bt-chip--primary" disabled={busy}>
            {busy ? "Saving…" : editingId ? "Save changes" : "Add catalyst"}
          </button>
          {editingId && (
            <button type="button" class="bt-chip" onClick={reset}>
              Cancel edit
            </button>
          )}
          <span role="status">{message}</span>
        </div>
      </form>

      <h3 class="bt-subhead">Manual entries</h3>
      {loadFailed && (
        <p class="bt-state bt-state--error" role="alert">
          Could not load catalyst entries.
        </p>
      )}
      {items && manual.length === 0 && <p class="bt-muted">No manual entries yet.</p>}
      {manual.length > 0 && (
        <ul class="bt-admin-list">
          {manual.map((c) => (
            <li key={c.id}>
              <span class="bt-admin-list__text">
                <strong>{c.ticker}</strong> {c.program} · {CATALYST_TYPE_LABELS[c.eventType]} · {formatCatalystDate(c)} · {CATALYST_STATUS_LABELS[c.status]}
              </span>
              <span class="bt-admin-list__actions">
                <button type="button" class="bt-chip" aria-label={`Edit ${c.ticker} ${c.program}`} onClick={() => (setForm(toForm(c)), setEditingId(c.id), setErrors({}), setMessage(null))}>
                  Edit
                </button>
                <button type="button" class="bt-chip" aria-label={`Delete ${c.ticker} ${c.program}`} onClick={() => void remove(c)}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {items && (
        <p class="bt-muted">
          {registryCount} registry-derived estimate{registryCount === 1 ? "" : "s"} stored. They update automatically; to replace one, add a manual entry with the same NCT number.
        </p>
      )}
    </div>
  );
}
