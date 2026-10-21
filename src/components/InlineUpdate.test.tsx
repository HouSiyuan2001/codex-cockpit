// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InlineUpdate } from "./InlineUpdate";
import type { UpdatePhase } from "./UpdatePanel";

afterEach(cleanup);
it.each<UpdatePhase>(["checking", "current", "error", "available", "downloading", "ready", "installing"])("renders %s inline without a modal", phase => {
  const actions = { onDownload: vi.fn(), onInstall: vi.fn(), onRetry: vi.fn(), onOpenRelease: vi.fn() };
  render(<InlineUpdate language="zh-CN" state={{ phase, info: { version: "0.4.0", channel: "stable", platform: "windows", automaticInstall: true, releaseUrl: "https://example.com", body: null, date: null }, progress: { percent: 42, downloadedBytes: 42, totalBytes: 100 }, error: phase === "error" ? "网络暂不可用" : null }} {...actions} />);
  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(actions.onInstall).not.toHaveBeenCalled();
  if (phase === "downloading") expect(screen.getByRole("progressbar")).toHaveAttribute("value", "42");
  if (phase === "available" || phase === "ready" || phase === "error") {
    fireEvent.click(screen.getByRole("button"));
    expect(phase === "available" ? actions.onDownload : phase === "ready" ? actions.onInstall : actions.onRetry).toHaveBeenCalledOnce();
  }
});
