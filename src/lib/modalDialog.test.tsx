// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModalDialog } from "./modalDialog";

afterEach(cleanup);

function TestDialog({ onClose, closeOnEscape = true }: { onClose: () => void; closeOnEscape?: boolean }) {
  const dialogRef = useModalDialog<HTMLElement>(onClose, closeOnEscape);
  return (
    <section ref={dialogRef} role="dialog" tabIndex={-1}>
      <button type="button" data-dialog-initial-focus>First</button>
      <button type="button">Last</button>
    </section>
  );
}

describe("modal dialog keyboard behavior", () => {
  it("moves focus into the dialog, traps Tab, and closes on Escape", () => {
    const onClose = vi.fn();
    render(<TestDialog onClose={onClose} />);

    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores focus and can block Escape during a non-dismissible operation", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<TestDialog onClose={onClose} closeOnEscape={false} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
