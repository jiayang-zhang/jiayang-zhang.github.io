import { useEffect, useState } from "preact/hooks";
import type { AdminSession } from "../../../shared/types";
import { ApiError, type Api, type RefreshResult } from "../api";
import { CatalystAdmin } from "./CatalystAdmin";
import { ModuleBoundary, ModuleCard } from "./ModuleCard";

type SessionState = { phase: "checking" } | { phase: "signed-out" } | { phase: "signed-in"; session: AdminSession };

function RefreshButton({ label, run }: { label: string; run: () => Promise<RefreshResult> }) {
  const unit = label.includes("registry") ? "entries" : "tickers";
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await run();
      setMessage(r.failed.length === 0 ? `Updated ${r.updated} ${unit}.` : `Updated ${r.updated}; failed: ${r.failed.join(", ")}.`);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      setMessage(status === 401 ? "Session expired. Sign in again." : status === 429 ? "Too many requests. Wait a minute." : "Refresh failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="bt-admin-action">
      <button type="button" class="bt-chip" disabled={busy} onClick={() => void onClick()}>
        {busy ? "Working…" : label}
      </button>
      <span role="status">{message}</span>
    </div>
  );
}

export function AdminApp({ api }: { api: Api }) {
  const [state, setState] = useState<SessionState>({ phase: "checking" });

  useEffect(() => {
    api.session().then(
      (session) => setState({ phase: "signed-in", session }),
      // A missing session surfaces as 401, or as a blocked redirect to the login page.
      () => setState({ phase: "signed-out" }),
    );
  }, [api]);

  return (
    <ModuleBoundary name="Admin">
      <ModuleCard id="bt-admin" title="Dashboard admin" meta={state.phase === "signed-in" ? <span>Signed in as {state.session.email}</span> : undefined}>
        {state.phase === "checking" && (
          <p class="bt-state" role="status">
            Checking session…
          </p>
        )}
        {state.phase === "signed-out" && (
          <div class="bt-state">
            <p>Administrator sign-in required.</p>
            <a class="bt-chip" href={api.loginUrl(window.location.href)}>
              Sign in
            </a>
          </div>
        )}
        {state.phase === "signed-in" && (
          <div>
            <h3 class="bt-subhead">Manual refresh</h3>
            <RefreshButton label="Refresh prices now" run={api.refreshMarket} />
            <RefreshButton label="Refresh market caps" run={api.refreshProfiles} />
            <RefreshButton label="Sync registry readouts" run={api.refreshCatalysts} />
            <CatalystAdmin api={api} />
          </div>
        )}
      </ModuleCard>
    </ModuleBoundary>
  );
}
