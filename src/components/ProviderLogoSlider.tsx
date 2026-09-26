import { type PointerEvent as ReactPointerEvent, useRef } from "react";
import type { ProviderId } from "../types";
import { ProviderMark } from "./ProviderMark";

interface Props {
  providers: ReadonlyArray<{ id: ProviderId; label: string }>;
  selected: ProviderId;
  onSelect: (provider: ProviderId) => void;
  ariaLabel: string;
  compact?: boolean;
}

export function ProviderLogoSlider({ providers, selected, onSelect, ariaLabel, compact = false }: Props) {
  const dragging = useRef(false);

  const selectAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || providers.length === 0) return;
    const progress = Math.max(0, Math.min(0.9999, (event.clientX - bounds.left) / bounds.width));
    onSelect(providers[Math.floor(progress * providers.length)].id);
  };

  return (
    <div
      className={`provider-logo-slider${compact ? " provider-logo-slider--compact" : ""}`}
      role="radiogroup"
      aria-label={ariaLabel}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        dragging.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        selectAt(event);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        event.preventDefault();
        event.stopPropagation();
        selectAt(event);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => { dragging.current = false; }}
    >
      {providers.map((provider) => (
        <button
          key={provider.id}
          type="button"
          role="radio"
          aria-checked={selected === provider.id}
          aria-label={provider.label}
          title={provider.label}
          className={selected === provider.id ? "is-active" : ""}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(provider.id);
          }}
        >
          <ProviderMark provider={provider.id} label={provider.label} />
        </button>
      ))}
    </div>
  );
}
