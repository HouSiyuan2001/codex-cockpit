// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CODEX_RESETS_URL } from "../lib/externalLinks";
import { ResetWatchBell } from "./ResetWatchBell";

afterEach(cleanup);
it.each(["zh-CN", "en"] as const)("opens the fixed source website without dragging in %s", (language) => {
  const onOpen = vi.fn();
  const drag = vi.fn();
  render(<div onMouseDown={drag} onPointerDown={drag} onClick={drag}><ResetWatchBell
    language={language}
    watch={{ level: "strong", resetChancePercent: 70, observedAt: "2026-09-09T05:00:00Z", expiresAt: "2026-09-10T05:00:00Z" }}
    onOpen={onOpen}
  /></div>);
  const bell = screen.getByRole("button", { name: /70%.*codex-resets.com/ });
  fireEvent.pointerDown(bell);
  fireEvent.mouseDown(bell);
  fireEvent.click(bell);
  expect(drag).not.toHaveBeenCalled();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(CODEX_RESETS_URL);
});
