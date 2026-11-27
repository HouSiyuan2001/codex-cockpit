import { useLayoutEffect, type RefObject } from "react";

/** Fit the actual glyph box into the hole, including the smaller Plus inner ring.
 * Character counts are not useful here: a decimal point is narrower than a digit,
 * and the same number has very different metrics in WenKai, Times and Smiley. */
export function ringReadoutFit(width: number, height: number, visualWidth: number, dual: boolean, inset = 10): number {
  if (![width, height, visualWidth].every(value => Number.isFinite(value) && value > 0)) return 1;
  // SVG radius minus half the 8-unit stroke, with a little breathing room.
  const diameter = visualWidth * (2 * (dual ? 38 : 49) / 140) - inset;
  return Math.max(0, Math.min(1, diameter / Math.hypot(width, height)));
}

export function useRingReadoutFit(ref: RefObject<HTMLDivElement | null>, value: string, dual: boolean, inset = 10): void {
  useLayoutEffect(() => {
    const readout = ref.current;
    const visual = readout?.parentElement;
    if (!readout || !visual) return;
    let disposed = false;
    const fit = () => {
      if (disposed) return;
      // Measure at the chosen font's natural size; never scale a bitmap layer.
      readout.style.removeProperty("--ring-readout-fit");
      const bounds = readout.getBoundingClientRect();
      const visualWidth = visual.getBoundingClientRect().width;
      let scale = ringReadoutFit(bounds.width, bounds.height, visualWidth, dual, inset);
      // Optical sizing / pixel rounding can change metrics at the fitted size.
      // A bounded correction keeps the final box inside the hole as well.
      for (let pass = 0; pass < 3; pass++) {
        readout.style.setProperty("--ring-readout-fit", String(scale));
        const actual = readout.getBoundingClientRect();
        const correction = ringReadoutFit(actual.width, actual.height, visualWidth, dual, inset);
        if (correction >= .999) break;
        scale *= correction;
      }
      readout.style.setProperty("--ring-readout-fit", String(scale));
    };
    fit();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resize?.observe(visual);
    const appearance = new MutationObserver(fit);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-font-family", "style"] });
    // Recheck after a bundled or local font finishes loading, not just on resize.
    const fonts = document.fonts;
    void fonts?.ready.then(fit);
    fonts?.addEventListener("loadingdone", fit);
    window.addEventListener("resize", fit);
    return () => {
      disposed = true;
      resize?.disconnect();
      appearance.disconnect();
      fonts?.removeEventListener("loadingdone", fit);
      window.removeEventListener("resize", fit);
    };
  }, [ref, value, dual, inset]);
}
