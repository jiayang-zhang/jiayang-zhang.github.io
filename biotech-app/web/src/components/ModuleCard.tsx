import { Component, type ComponentChildren } from "preact";
import { useState } from "preact/hooks";

interface CardProps {
  id: string;
  title: string;
  /** Shown beside the title, e.g. "Updated Oct 10, 4:05 PM". */
  meta?: ComponentChildren;
  children: ComponentChildren;
}

export function ModuleCard({ id, title, meta, children }: CardProps) {
  const [open, setOpen] = useState(true);
  const bodyId = `${id}-body`;
  return (
    <section class="bt-card" aria-labelledby={`${id}-title`}>
      <header class="bt-card__head">
        <button type="button" class="bt-card__toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span id={`${id}-title`} class="bt-card__title">
            {title}
          </span>
        </button>
        {meta && <div class="bt-card__meta">{meta}</div>}
      </header>
      <div id={bodyId} class="bt-card__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** Keeps a rendering failure in one module from taking down the others. */
export class ModuleBoundary extends Component<{ name: string; children: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <section class="bt-card">
          <p class="bt-state bt-state--error" role="alert">
            {this.props.name} could not be displayed. Other modules are unaffected.
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}
