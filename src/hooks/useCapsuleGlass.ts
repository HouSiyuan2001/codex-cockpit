import { useEffect, useRef } from "react";
import { isTauri } from "../lib/bridge";

type GlassFrame = { x: number; y: number; width: number; height: number; radius: number; dark: boolean };

// Order removal and creation across quick collapse/expand transitions.
let update = Promise.resolve(false);
function setGlass(frame: GlassFrame | null): Promise<boolean> {
  update = update.then(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("set_capsule_glass", { frame });
  }).catch(() => false);
  return update;
}

export function useCapsuleGlass(enabled: boolean, dark: boolean) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled || !isTauri() || !/^Mac/i.test(navigator.platform)) return;

    let active = true;
    let previousFrame = "";
    const observer = new ResizeObserver(() => {
      const { x, y, width, height } = node.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const radius = parseFloat(getComputedStyle(node).borderTopLeftRadius);
      const frame = { x, y, width, height, radius, dark };
      const key = JSON.stringify(frame);
      if (key === previousFrame) return;
      previousFrame = key;
      void setGlass(frame).then((ready) => {
        if (active && key === previousFrame) node.toggleAttribute("data-capsule-glass", ready);
      });
    });
    observer.observe(node);

    return () => {
      active = false;
      observer.disconnect();
      node.removeAttribute("data-capsule-glass");
      void setGlass(null);
    };
  }, [enabled, dark]);

  return ref;
}
