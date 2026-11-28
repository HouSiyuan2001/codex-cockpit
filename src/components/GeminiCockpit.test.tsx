// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlCenter } from "./ControlCenter";
import { QuotaCard, QuotaOrb } from "./QuotaCard";
import { DEFAULT_WIDGET_PREFERENCES, normalizeWidgetPreferences } from "../lib/preferences";
import { buildClaudeCockpitView } from "../lib/claudeCockpit";
import { buildGeminiCockpitView } from "../lib/geminiCockpit";
import type { CapsuleCorner, ClaudeQuota, GeminiQuota, ProviderSnapshot } from "../types";

afterEach(cleanup);

const now = new Date("2026-11-26T12:00:00Z");

const codex: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: { remainingPercent: 74, resetsAt: "2026-11-30T14:00:00Z", windowSeconds: 604_800 },
  resetCredits: 1,
  updatedAt: now.toISOString(),
  status: "ok",
  message: null,
};

const claudeQuota: ClaudeQuota = {
  status: "ok",
  fiveHour: { usedPercent: 38, resetsAt: "2026-11-26T14:30:00Z" },
  sevenDay: { usedPercent: 57, resetsAt: "2026-11-29T08:00:00Z" },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  plan: "max",
  observedAt: now.toISOString(),
  message: null,
};

const geminiQuota: GeminiQuota = {
  status: "ok",
  plan: "Google AI Pro",
  observedAt: now.toISOString(),
  message: null,
  gemini: {
    fiveHour: { remainingPercent: 86.4, resetsAt: "2026-11-26T15:00:00Z" },
    weekly: { remainingPercent: 71.8, resetsAt: null },
  },
  claudeGpt: {
    fiveHour: { remainingPercent: 90.6, resetsAt: null },
    weekly: { remainingPercent: 63.5, resetsAt: "2026-11-29T12:00:00Z" },
  },
};

const noop = () => undefined;

describe("Gemini settings switch", () => {
  it("defaults off, toggles cleanly, and returns Gemini mode to Codex when switched off", () => {
    const onPreferences = vi.fn();
    const { rerender } = render(
      <ControlCenter
        preferences={DEFAULT_WIDGET_PREFERENCES}
        language="zh-CN"
        onClose={noop}
        onRefresh={noop}
        onPreferences={onPreferences}
        autostartEnabled={false}
        onAutostart={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("checkbox", { name: "Codex 驾驶舱" })).toBeChecked();
    const geminiToggle = screen.getByRole("checkbox", { name: "Gemini" });
    expect(geminiToggle).not.toBeChecked();
    fireEvent.click(geminiToggle);
    expect(onPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ geminiEnabled: true }));

    rerender(
      <ControlCenter
        preferences={{ ...DEFAULT_WIDGET_PREFERENCES, geminiEnabled: true, cockpitMode: "gemini" }}
        language="zh-CN"
        onClose={noop}
        onRefresh={noop}
        onPreferences={onPreferences}
        autostartEnabled={false}
        onAutostart={noop}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Gemini" }));
    expect(onPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ geminiEnabled: false, cockpitMode: "codex" }));
  });
});

describe("Gemini model pools", () => {
  const corners = [
    ["right-bottom", "bottom", "right"],
    ["left-bottom", "bottom", "left"],
    ["right-top", "top", "right"],
    ["left-top", "top", "left"],
  ] as const;
  it.each(corners.flatMap(([corner, row, column]) =>
    (["codex", "claude"] as const).map(companion => ({ corner, row, column, companion })),
  ))("places the expanded $companion and Gemini cards like the $corner capsule", ({ corner, row, column, companion }) => {
    const preferences = normalizeWidgetPreferences({
      ...DEFAULT_WIDGET_PREFERENCES,
      cockpitMode: "ai",
      codexEnabled: companion === "codex",
      claudeEnabled: companion === "claude",
      geminiEnabled: true,
    });
    const { container } = render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={preferences}
        capsuleCorner={corner}
        claudeView={buildClaudeCockpitView(claudeQuota, now)}
        geminiView={buildGeminiCockpitView(geminiQuota, now)}
        onCockpitModeChange={noop}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );
    const grid = container.querySelector(".cockpit-ai-grid")!;
    expect(grid).toHaveAttribute("data-gemini-row", row);
    expect(grid).toHaveAttribute("data-companion-column", column);
    const labels = Array.from(grid.querySelectorAll(".codex-ring-card[role=group]"), card => card.getAttribute("aria-label"));
    const geminiLabels = ["Gemini 72%", "Gemini · Claude / GPT 64%"];
    const companionLabel = companion === "codex" ? "Codex 74%" : "Claude 43%";
    expect(labels).toEqual(row === "top" ? [...geminiLabels, companionLabel] : [companionLabel, ...geminiLabels]);
    const hiddenProvider = companion === "codex" ? "Claude" : "Codex";
    expect(screen.queryByRole("radio", { name: `${hiddenProvider} 驾驶舱` })).toBeNull();
    expect(screen.getByRole("radio", { name: "AI 驾驶舱" })).toHaveAttribute("aria-checked", "true");
  });

  it("keeps Gemini statistics under Usage and opens Codex pacing from there", async () => {
    render(
      <ControlCenter
        preferences={{ ...DEFAULT_WIDGET_PREFERENCES, geminiEnabled: true }}
        language="zh-CN"
        onClose={noop}
        onRefresh={noop}
        onPreferences={noop}
        autostartEnabled={false}
        onAutostart={noop}
      />,
    );
    const gemini = screen.getByRole("radio", { name: "Gemini" });
    fireEvent.click(gemini);
    expect(gemini).toHaveAttribute("aria-checked", "true");
    const usage = await screen.findByRole("region", { name: "Gemini 用量" });
    expect(within(usage).getByRole("combobox", { name: "查看方式" })).toBeVisible();
    expect(within(usage).getByRole("button", { name: "日历" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Gemini 额度" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Codex 配速" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-cockpit-mode", "codex");
    expect(screen.queryByRole("radio", { name: "Gemini" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开 Codex Resets" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "用量" }));
    expect(screen.getByRole("radio", { name: "Gemini" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows check-in for Codex in AI mode and hides it when Codex is off", () => {
    const onCockpitModeChange = vi.fn();
    const renderCard = (codexEnabled: boolean) => <QuotaCard
      snapshot={codex}
      snapshots={[codex]}
      preferences={{ ...DEFAULT_WIDGET_PREFERENCES, codexEnabled, claudeEnabled: true, geminiEnabled: true, cockpitMode: "ai" }}
      comfortPrompt={{ localDate: "2026-11-26", isCatchUp: false, observedUsedPercent: null, usageObservedAt: null, usageCoverage: "unavailable", usageSource: "unavailable" }}
      geminiView={buildGeminiCockpitView(geminiQuota, now)}
      onCockpitModeChange={onCockpitModeChange}
      onSelectProvider={noop}
      onLock={noop}
      onLanguage={noop}
      onDrag={noop}
      onHover={noop}
      consumingProviders={new Set()}
    />;
    const { rerender } = render(renderCard(true));
    const prompt = screen.getByRole("region", { name: "今天感觉？" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Codex 驾驶舱" }));
    expect(onCockpitModeChange).toHaveBeenCalledWith("codex");
    rerender(renderCard(false));
    expect(screen.queryByRole("region", { name: "今天感觉？" })).toBeNull();
  });

  it("renders each model pool once with both windows and known reset times", () => {
    const onCockpitModeChange = vi.fn();
    const { container } = render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={{ ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true, geminiEnabled: true, cockpitMode: "gemini" }}
        now={now}
        geminiView={buildGeminiCockpitView(geminiQuota, now)}
        onCockpitModeChange={onCockpitModeChange}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    expect(container.querySelector(".codex-focus-card")).toHaveClass("cockpit-mode--gemini");
    expect(screen.getByText("Gemini 驾驶舱")).toBeInTheDocument();

    const cards = Array.from(container.querySelectorAll(".gemini-quota-card > .codex-ring-card"));
    expect(cards.map(card => card.getAttribute("aria-label"))).toEqual(["Gemini 72%", "Gemini · Claude / GPT 64%"]);
    const footerRows = (card: Element) => Array.from(
      card.querySelectorAll(".reset-countdown-footer > span"),
      row => row.textContent,
    );
    expect(footerRows(cards[0])).toEqual(["本周剩余 72%", "周重置 —", "5 小时剩余 86%", "5h 重置 3小时"]);
    expect(within(cards[1] as HTMLElement).getByText("Gemini · Claude / GPT")).toBeVisible();
    expect(footerRows(cards[1])).toEqual(["本周剩余 64%", "周重置 3天", "5 小时剩余 91%", "5h 重置 —"]);
    expect(cards[1].querySelector(".codex-ring-progress--five-hour")).toHaveAttribute("stroke-dasharray", "91 9");

    fireEvent.click(screen.getByRole("radio", { name: "Codex 驾驶舱" }));
    expect(onCockpitModeChange).toHaveBeenCalledWith("codex");
  });

  it("renders missing placeholders for both model pools when no official quota source is available", () => {
    const unavailable: GeminiQuota = {
      status: "unavailable",
      gemini: null,
      claudeGpt: null,
      plan: null,
      observedAt: now.toISOString(),
      message: "Antigravity does not yet provide an official read-only quota interface.",
    };
    const { container } = render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={{ ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true, geminiEnabled: true, cockpitMode: "gemini" }}
        now={now}
        geminiView={buildGeminiCockpitView(unavailable, now)}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    const cards = Array.from(container.querySelectorAll(".gemini-quota-card > .codex-ring-card"));
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Gemini",
      "Gemini · Claude / GPT",
    ]);
    for (const card of cards) {
      expect(within(card as HTMLElement).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("Gemini floating capsules", () => {
  it("renders a single joined horizontal double capsule when Gemini is alone", () => {
    const quota = buildGeminiCockpitView(geminiQuota, now);
    const { container } = render(
      <QuotaOrb
        snapshot={codex}
        compactLayout="capsule"
        cockpitMode="gemini"
        codexEnabled={false}
        claudeEnabled={false}
        geminiEnabled
        geminiFiveHourRemaining={quota.geminiFiveHour.remaining}
        geminiWeeklyRemaining={quota.geminiWeekly.remaining}
        sharedFiveHourRemaining={quota.sharedFiveHour.remaining}
        sharedWeeklyRemaining={quota.sharedWeekly.remaining}
        onDrag={noop}
      />,
    );
    const orb = container.querySelector(".quota-orb")!;
    expect(orb).toHaveClass("cockpit-mode--gemini");
    expect(orb).not.toHaveClass("quota-orb--multi-row");
    const cells = orb.querySelectorAll(".capsule-gemini-pair > .capsule-quota-readout");
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent("14%");
    expect(cells[1]).toHaveTextContent("9%");
  });

  it.each([
    [100, "0%", "normal"],
    [31, "69%", "normal"],
    [30, "70%", "warning"],
    [6, "94%", "warning"],
    [5, "95%", "over"],
    [0, "100%", "over"],
    [null, "—", "normal"],
  ] as const)("shows 5h usage and the correct warning with %s remaining", (remaining, text, tone) => {
    const { container } = render(
      <QuotaOrb
        snapshot={codex}
        compactLayout="capsule"
        cockpitMode="gemini"
        codexEnabled={false}
        geminiEnabled
        geminiFiveHourRemaining={remaining}
        geminiWeeklyRemaining={72}
        sharedFiveHourRemaining={remaining}
        sharedWeeklyRemaining={64}
        onDrag={noop}
      />,
    );
    const cells = container.querySelectorAll(".capsule-gemini-pair > .capsule-quota-readout");
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell).toHaveTextContent(text);
      expect(cell).toHaveClass(`capsule-quota-readout--${tone}`);
    }
    expect(screen.getByRole("button")).toHaveAccessibleName(expect.stringContaining(`5h 已用 ${text}; 本周剩余 72%`));
  });

  it.each(["codex", "claude"] as const)("renders %s companion L-capsules across all four corners with an empty fourth quadrant", (companion) => {
    const corners: Array<[CapsuleCorner, string, string, string]> = [
      ["right-bottom", "2", "2", "left-top"],
      ["left-bottom", "2", "1", "right-top"],
      ["right-top", "1", "2", "left-bottom"],
      ["left-top", "1", "1", "right-bottom"],
    ];

    for (const [corner, expectedGeminiRow, expectedCompanionCol, expectedEmpty] of corners) {
      const { container, unmount } = render(
        <QuotaOrb
          snapshot={codex}
          compactLayout="capsule"
          cockpitMode="ai"
          codexEnabled={companion === "codex"}
          claudeEnabled={companion === "claude"}
          geminiEnabled
          capsuleCorner={corner}
          dailyBudgetPercent={10}
          claudeWeeklyRemaining={43}
          claudeFiveHourUsed={38}
          geminiFiveHourRemaining={86}
          geminiWeeklyRemaining={72}
          sharedFiveHourRemaining={91}
          sharedWeeklyRemaining={64}
          onDrag={noop}
        />,
      );
      const orb = container.querySelector(".quota-orb--corner-l") as HTMLElement;
      expect(orb).toBeInTheDocument();
      expect(orb).toHaveAttribute("data-capsule-corner", corner);
      expect(orb).toHaveAttribute("data-empty-quadrant", expectedEmpty);
      expect(orb.children).toHaveLength(2);

      const geminiTile = orb.querySelector(".capsule-tile--gemini-row") as HTMLElement;
      const companionTile = orb.querySelector(".capsule-tile--companion") as HTMLElement;
      expect(geminiTile.style.gridRow).toBe(expectedGeminiRow);
      expect(companionTile.style.gridColumn).toBe(expectedCompanionCol);

      // The Gemini pool stays left and the shared pool stays right.
      const geminiReadouts = geminiTile.querySelectorAll(".capsule-quota-readout");
      expect(geminiReadouts[0]).toHaveTextContent("14%");
      expect(geminiReadouts[1]).toHaveTextContent("9%");
      unmount();
    }
  });

  it("renders Gemini ①/② on top and independent Codex/Claude on bottom when all three are enabled", () => {
    const claudeView = buildClaudeCockpitView(claudeQuota, now);
    const { container } = render(
      <QuotaOrb
        snapshot={codex}
        compactLayout="capsule"
        cockpitMode="ai"
        codexEnabled
        claudeEnabled
        geminiEnabled
        dailyBudgetPercent={10}
        claudeWeeklyRemaining={claudeView.weeklyRemaining}
        claudeFiveHourUsed={claudeView.fiveHourUsed}
        geminiFiveHourRemaining={86}
        geminiWeeklyRemaining={72}
        sharedFiveHourRemaining={91}
        sharedWeeklyRemaining={64}
        onDrag={noop}
      />,
    );
    const orb = container.querySelector(".quota-orb--quad-all")!;
    expect(orb).toBeInTheDocument();
    const topCells = orb.querySelectorAll(".capsule-tile--quad-top .capsule-quota-readout");
    const bottomCells = orb.querySelectorAll(".capsule-tile--quad-bottom .capsule-quota-readout");
    expect(topCells).toHaveLength(2);
    expect(topCells[0]).toHaveTextContent("14%");
    expect(topCells[1]).toHaveTextContent("9%");
    expect(bottomCells).toHaveLength(2);
    expect(bottomCells[1]).toHaveTextContent("38%");
  });
});

it("reuses the daily ring allocation as a segmented bar in the AI Codex card", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    const preferences = normalizeWidgetPreferences({
      ...DEFAULT_WIDGET_PREFERENCES,
      cockpitMode: "ai",
      codexEnabled: true,
      claudeEnabled: true,
      dailyBudgetPercent: 20,
    });
    const { container } = render(<QuotaCard
      snapshot={codex} snapshots={[codex]} preferences={preferences} now={now}
      claudeView={buildClaudeCockpitView(claudeQuota, now)}
      codexDailyUsage={{ localDate: "2026-11-26", observedUsedPercent: 10, coverage: "complete", sampleCount: 1, firstObservedAt: codex.updatedAt, lastObservedAt: codex.updatedAt, source: "codex-session-rate-limits" }}
      dailyPersonCosts={{ partial: false, people: [
        { id: "alex", name: "成员甲", cost: 30, share: .3, color: "#d37898", unassigned: false },
        { id: "blair", name: "成员乙", cost: 70, share: .7, color: "#648cca", unassigned: false },
      ] }}
      onCockpitModeChange={noop} onSelectProvider={noop} onLock={noop} onLanguage={noop}
      onDrag={noop} onHover={noop} consumingProviders={new Set()}
    />);
    const card = screen.getByRole("group", { name: /Codex 74%/ });
    expect(within(card).getByText("50%")).toBeInTheDocument();
    expect(within(card).getByText("15%")).toBeInTheDocument();
    expect(within(card).getByText("35%")).toBeInTheDocument();
    expect(card.querySelector(".person-cost-bar-track > span")).toHaveStyle({ width: "15%" });
    expect(container.querySelector(".codex-ring-card--claude .person-cost-bar")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
