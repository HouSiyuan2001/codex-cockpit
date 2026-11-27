export function measureSurfaceHeight(surface: HTMLElement): number | undefined {
  const rectHeight = surface.getBoundingClientRect().height;
  const body = surface.querySelector(".codex-focus-body");
  const viewport = body?.parentElement;
  // Only count the clipped content, excluding the decorative overflow.
  const clippedHeight = body && viewport
    ? Math.max(0, body.getBoundingClientRect().height - viewport.getBoundingClientRect().height)
    : 0;
  const height = Math.max(rectHeight, surface.clientHeight) + clippedHeight;
  return Number.isFinite(height) && height > 0 ? Math.ceil(height) : undefined;
}
