import { render, type ComponentChild } from "preact";
import { dashboardConfig } from "../../shared/config";
import { createApi } from "./api";
import { AdminApp } from "./components/AdminApp";
import { CatalystModule } from "./components/CatalystModule";
import { ModuleBoundary } from "./components/ModuleCard";
import { StockModule } from "./components/StockModule";
import "./styles.css";

function mount(id: string, view: (apiBase: string) => ComponentChild) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("biotech-app", `bt-conv--${dashboardConfig.display.changeColorConvention}`);
  render(view(el.dataset.apiBase ?? ""), el);
}

// Each module sits in its own boundary and fetches independently, so one
// failing module cannot stop the others from rendering.
mount("biotech-root", (base) => {
  const api = createApi(base);
  return (
    <div class="bt-grid">
      <ModuleBoundary name="Stock Performance">
        <StockModule api={api} />
      </ModuleBoundary>
      <ModuleBoundary name="Catalyst Calendar">
        <CatalystModule api={api} />
      </ModuleBoundary>
    </div>
  );
});

mount("biotech-admin-root", (base) => <AdminApp api={createApi(base)} />);
