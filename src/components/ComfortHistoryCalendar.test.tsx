// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMFORT_CURVE_VERSION } from "../lib/comfortFeedback";
import type { CodexDailyUsage, ComfortFeedbackRecord, DailyUsageSummary } from "../types";
import { ComfortHistoryCalendar } from "./ComfortHistoryCalendar";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function record(overrides: Partial<ComfortFeedbackRecord> = {}): ComfortFeedbackRecord {
  return {
    localDate: "2026-08-12",
    observedAt: "2026-08-12T14:00:00.000Z",
    comfort: "comfortable",
    observedUsedPercent: 18,
    usageObservedAt: "2026-08-12T16:00:00.000Z",
    usageCoverage: "complete",
    usageSource: "official-snapshot",
    curveVersion: COMFORT_CURVE_VERSION,
    ...overrides,
  };
}

function usage(overrides: Partial<DailyUsageSummary> = {}): DailyUsageSummary {
  return {
    provider: "codex",
    localDate: "2026-08-12",
    observedUsedPercent: 12.5,
    sampleCount: 3,
    updatedAt: "2026-08-12T16:00:00.000Z",
    ...overrides,
  };
}

function officialUsage(overrides: Partial<CodexDailyUsage> = {}): CodexDailyUsage {
  return {
    localDate: "2026-08-12",
    observedUsedPercent: 12.5,
    sampleCount: 3,
    firstObservedAt: "2026-08-12T16:00:00.000Z",
    lastObservedAt: "2026-08-12T17:00:00.000Z",
    coverage: "partial",
    source: "official-snapshot",
    ...overrides,
  };
}

describe("ComfortHistoryCalendar", () => {
  it("shows emoji entries, edits a selected day, and disables future dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00+08:00"));
    const onChange = vi.fn();

    render(<ComfortHistoryCalendar records={[record()]} dailyUsage={[usage()]} language="en" onChange={onChange} />);

    const recordedDay = screen.getByRole("gridcell", { name: /Aug 12.*Just right.*weekly quota used 12\.5%/i });
    expect(recordedDay).toHaveTextContent("🙂");
    expect(recordedDay).toHaveTextContent("12.5%");

    fireEvent.click(recordedDay);
    fireEvent.click(screen.getByRole("radio", { name: "Too much" }));

    expect(onChange).toHaveBeenCalledWith("2026-08-12", "overloaded");

    fireEvent.click(screen.getByRole("button", { name: "Next 7 days" }));
    expect(screen.getByRole("gridcell", { name: /Sat, Aug 15/i })).toBeDisabled();
  });

  it("prefers official history over stale refresh snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00+08:00"));

    render(
      <ComfortHistoryCalendar
        records={[record()]}
        dailyUsage={[usage({ observedUsedPercent: 99 })]}
        dailyUsageHistory={[officialUsage({ observedUsedPercent: 5 })]}
        language="en"
        onChange={vi.fn()}
      />,
    );

    const recordedDay = screen.getByRole("gridcell", { name: /Aug 12.*weekly quota used ≥5%/i });
    expect(recordedDay).toHaveTextContent("≥5%");
    expect(recordedDay).not.toHaveTextContent("99%");
  });

  it("defaults to the continuous seven days ending today with matching weekdays", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00+08:00"));

    render(<ComfortHistoryCalendar records={[record()]} dailyUsage={[usage()]} language="en" onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Last 7 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "false");
    const cells = screen.getAllByRole("gridcell");
    expect(cells).toHaveLength(7);
    expect(cells[0]).toHaveAccessibleName(/Sat, Aug 8/);
    expect(cells[1]).toHaveAccessibleName(/Sun, Aug 9/);
    expect(cells[6]).toHaveAccessibleName(/Fri, Aug 14/);
    expect(screen.getByRole("grid", { name: "Aug 8–Aug 14, 2026" })).toBeInTheDocument();
  });

  it("moves the week by seven days and Today restores the current range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00+08:00"));
    const onChange = vi.fn();

    render(<ComfortHistoryCalendar records={[record()]} language="en" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous 7 days" }));
    expect(screen.getByRole("grid", { name: "Aug 1–Aug 7, 2026" })).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell")).toHaveLength(7);

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("grid", { name: "Aug 8–Aug 14, 2026" })).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: /Fri, Aug 14/ })).toHaveAttribute("aria-selected", "true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows a new day at midnight until the user navigates away", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T23:59:00+08:00"));

    const { rerender } = render(<ComfortHistoryCalendar records={[record()]} language="en" onChange={vi.fn()} />);
    expect(screen.getByRole("grid", { name: "Aug 8–Aug 14, 2026" })).toBeInTheDocument();

    vi.setSystemTime(new Date("2026-08-15T00:01:00+08:00"));
    rerender(<ComfortHistoryCalendar records={[record()]} language="en" onChange={vi.fn()} />);
    expect(screen.getByRole("grid", { name: "Aug 9–Aug 15, 2026" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous 7 days" }));
    expect(screen.getByRole("grid", { name: "Aug 2–Aug 8, 2026" })).toBeInTheDocument();

    vi.setSystemTime(new Date("2026-08-16T00:01:00+08:00"));
    rerender(<ComfortHistoryCalendar records={[record()]} language="en" onChange={vi.fn()} />);
    expect(screen.getByRole("grid", { name: "Aug 2–Aug 8, 2026" })).toBeInTheDocument();
  });

  it("keeps the original month calendar navigation behind the Month switch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00+08:00"));
    const onChange = vi.fn();

    render(<ComfortHistoryCalendar records={[record()]} language="en" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Month" }));

    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("grid", { name: "August 2026" })).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell")).toHaveLength(42);
    expect(screen.getByRole("gridcell", { name: /Sat, Aug 15/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("grid", { name: "July 2026" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("grid", { name: "August 2026" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
