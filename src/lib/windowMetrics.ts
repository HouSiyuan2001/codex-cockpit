export function measureSurfaceHeight(surface: HTMLElement): number | undefined {
  const rectHeight = surface.getBoundingClientRect().height;
  const height = Math.max(rectHeight, surface.clientHeight);
  return Number.isFinite(height) && height > 0 ? Math.ceil(height) : undefined;
}
