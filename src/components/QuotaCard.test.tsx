// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexDailyUsage, ComfortPrompt, ProviderSnapshot, VolcengineDiagnostics, WidgetPreferences } from "../types";
import { DEFAULT_WIDGET_PREFERENCES } from "../lib/preferences";
import { capsuleLogicalWidth, QuotaCard, QuotaIsland, QuotaOrb } from "./QuotaCard";

const codex: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: { remainingPercent: 74, resetsAt: "2026-07-19T00:00:00Z", windowSeconds: 604_800 },
  resetCredits: 1,
  updatedAt: "2026-07-16T00:00:00Z",
  status: "ok",
  message: null,
};

it("segments only today's ring by money while keeping both center values", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-16T12:00:00+08:00"));
  const { container } = render(<QuotaCard snapshot={codex} snapshots={[codex]} preferences={{ ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true, dailyBudgetPercent: 20 }}
    codexDailyUsage={{ localDate: "2026-07-16", observedUsedPercent: 10, coverage: "complete", sampleCount: 1, firstObservedAt: codex.updatedAt, lastObservedAt: codex.updatedAt, source: "codex-session-rate-limits" }}
    dailyPersonCosts={{ partial: false, people: [{ id: "alex", name: "成员甲", cost: 30, share: .3, color: "purple", unassigned: false }, { id: "blair", name: "成员乙", cost: 70, share: .7, color: "teal", unassigned: false }] }}
    onSelectProvider={() => {}} onLock={() => {}} onLanguage={() => {}} onDrag={() => {}} onHover={() => {}} consumingProviders={new Set()} />);
  expect(container.querySelector(".codex-ring-card--weekly .codex-ring-value")).toHaveTextContent("74%");
  expect(container.querySelector(".codex-ring-card--daily .codex-ring-value")).toHaveTextContent("50%");
  expect(container.querySelectorAll(".codex-ring-card--weekly .person-cost-arc")).toHaveLength(0);
  expect(container.querySelectorAll(".codex-ring-card--daily .person-cost-arc")).toHaveLength(2);
  expect(container.querySelector('[data-person-id="alex"]')).toHaveAttribute("stroke-dasharray", "15 85");
  expect(screen.queryByText(/按金额估算分摊/)).not.toBeInTheDocument();
  expect(screen.queryByText("成员甲")).not.toBeInTheDocument();
  expect(screen.queryByText("成员乙")).not.toBeInTheDocument();
});

describe("Plus dual quota display", () => {
  const plus: ProviderSnapshot = { ...codex, plan: "PLUS", shortWindow: { remainingPercent: 42, resetsAt: "2026-07-16T05:00:00Z", windowSeconds: 18000 } };
  it("uses 5h remaining as the capsule number with two rings", () => {
    const { container, rerender } = render(<QuotaOrb snapshot={plus} compactLayout="capsule" onDrag={() => {}} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(/5 小时剩余 42%/);
    expect(container.querySelector(".capsule-daily-value")).toHaveTextContent("42%");
    expect(container.querySelector(".capsule-ring--five-hour")).toBeInTheDocument();
    rerender(<QuotaOrb snapshot={{ ...plus, shortWindow: { ...plus.shortWindow!, remainingPercent: 90 } }} compactLayout="capsule" onDrag={() => {}} />);
    expect(container.querySelector(".capsule-quota-readout--normal")).toBeInTheDocument();
    rerender(<QuotaOrb snapshot={{ ...plus, shortWindow: { ...plus.shortWindow!, remainingPercent: 0 } }} compactLayout="capsule" onDrag={() => {}} />);
    expect(container.querySelector(".capsule-daily-value")).toHaveTextContent("0%");
    expect(container.querySelector(".capsule-quota-readout--over")).toBeInTheDocument();
    rerender(<QuotaOrb snapshot={{ ...plus, shortWindow: null }} compactLayout="capsule" onDrag={() => {}} />);
    expect(container.querySelector(".capsule-daily-value")).toHaveTextContent("—");
    expect(container.querySelector(".capsule-daily-value")).not.toHaveTextContent("74");
    rerender(<QuotaOrb snapshot={codex} compactLayout="capsule" onDrag={() => {}} />);
    expect(container.querySelector(".capsule-ring--five-hour")).not.toBeInTheDocument();
  });
  it("shows 5h main value and weekly secondary value without changing daily planning", () => {
    const { container, rerender } = render(<QuotaCard snapshot={plus} snapshots={[plus]} preferences={{ ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true, language: "en" }}
      onSelectProvider={() => {}} onLock={() => {}} onLanguage={() => {}} onDrag={() => {}} onHover={() => {}} consumingProviders={new Set()} />);
    expect(screen.getByRole("group", { name: "5h remaining 42%" })).toHaveTextContent("Weekly remaining 74%");
    expect(container.querySelector(".codex-ring-progress--five-hour")).toHaveAttribute("stroke-dasharray", "42 58");
    rerender(<QuotaCard snapshot={{ ...plus, shortWindow: null }} snapshots={[plus]} preferences={{ ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true, language: "en" }}
      onSelectProvider={() => {}} onLock={() => {}} onLanguage={() => {}} onDrag={() => {}} onHover={() => {}} consumingProviders={new Set()} />);
    expect(screen.getByRole("group", { name: "5h remaining" })).toHaveTextContent("5h data unavailable");
  });
});

const qoder: ProviderSnapshot = {
  provider: "qoder",
  displayName: "QODER",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: null,
  resetCredits: null,
  balanceRemaining: 1280,
  balanceUnit: "credits",
  updatedAt: "2026-07-16T00:00:00Z",
  status: "ok",
  message: null,
};

const trae: ProviderSnapshot = {
  provider: "trae",
  displayName: "TRAE",
  plan: "Pro",
  shortWindow: null,
  weeklyWindow: null,
  resetCredits: null,
  balanceRemaining: 350,
  balanceUnit: "credits",
  updatedAt: "2026-07-16T00:00:00Z",
  status: "ok",
  message: null,
};

const antigravity: ProviderSnapshot = {
  provider: "antigravity",
  displayName: "ANTIGRAVITY",
  plan: "Google AI Pro",
  shortWindow: { remainingPercent: 68, resetsAt: "2026-07-19T04:00:00Z", windowSeconds: 18_000 },
  weeklyWindow: null,
  resetCredits: null,
  updatedAt: "2026-07-16T00:00:00Z",
  status: "ok",
  message: null,
};

const signedOutVolcengine: ProviderSnapshot = {
  ...codex,
  provider: "volcengine",
  displayName: "VOLCENGINE",
  plan: null,
  weeklyWindow: null,
  resetCredits: null,
  status: "signed_out",
  message: "Volcengine login expired. Reconnect to continue.",
};

const volcengine: ProviderSnapshot = {
  ...codex,
  provider: "volcengine",
  displayName: "VOLCENGINE",
  plan: "Coding Plan Personal",
  shortWindow: { remainingPercent: 90, resetsAt: "2026-07-20T03:00:00Z", windowSeconds: 18_000 },
  weeklyWindow: { remainingPercent: 80, resetsAt: "2026-07-25T00:00:00Z", windowSeconds: 604_800 },
  monthlyWindow: { remainingPercent: 45, resetsAt: "2026-08-09T00:00:00Z", windowSeconds: 31 * 86_400 },
  resetCredits: null,
};

const diagnostics: VolcengineDiagnostics = {
  installed: true,
  executablePath: "~\\AppData\\Roaming\\npm\\arkcli.cmd",
  executableSource: "npm fallback",
  stalePath: true,
  cliVersion: "arkcli version 1.0.3",
  authenticated: false,
  authMethod: null,
  profileName: "coding-plan_personal",
  profileType: "coding-plan",
  profileRegion: "cn-beijing",
  recommendedProfile: true,
  lastError: "Volcengine login expired. Reconnect to continue.",
};

const preferences: WidgetPreferences = {
  ...DEFAULT_WIDGET_PREFERENCES,
  codexFocusMode: false,
  hiddenProviders: [],
  locked: false,
      alwaysOnTop: true,
      stayExpanded: false,
  pinnedProvider: null,
  autoRotateSeconds: 12,
  language: "en",
};

const noop = () => undefined;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("QuotaCard platform ledger", () => {
  it("overlays the capsule ball with a Watch badge and preserves expansion", () => {
    const onActivate = vi.fn();
    const watch = { level: "strong" as const, resetChancePercent: 70, observedAt: "2026-09-09T05:00:00Z", expiresAt: "2026-09-10T05:00:00Z" };
    const { container, rerender } = render(<QuotaOrb snapshot={codex} compactLayout="capsule" resetWatch={watch} onDrag={noop} onActivate={onActivate} />);
    expect(container.querySelector(".capsule-ring-stack .capsule-watch-badge")).toBeInTheDocument();
    expect(container.querySelector(".capsule-daily-value")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重置预警/ }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    rerender(<QuotaOrb snapshot={codex} compactLayout="capsule" resetWatch={null} onDrag={noop} />);
    expect(container.querySelector(".capsule-watch-badge")).not.toBeInTheDocument();
  });

  it("places the clickable Watch next to the cockpit title", () => {
    const watch = { level: "elevated" as const, resetChancePercent: null, observedAt: "2026-09-09T05:00:00Z", expiresAt: "2026-09-10T05:00:00Z" };
    const onOpen = vi.fn();
    const { container } = render(<QuotaCard snapshot={codex} snapshots={[codex]} preferences={{ ...preferences, codexFocusMode: true }}
      resetWatch={watch} onOpenResetForecast={onOpen} onSelectProvider={noop} onLock={noop} onLanguage={noop}
      onDrag={noop} onHover={noop} consumingProviders={new Set()} />);
    const title = container.querySelector(".codex-focus-title-row")!;
    expect(title).toHaveTextContent("Codex Cockpit");
    expect(container.querySelector(".codex-focus-brand-copy > small")).not.toBeInTheDocument();
    expect(screen.queryByText(/LOCAL FIRST|本地优先 · 官方快照/)).not.toBeInTheDocument();
    const button = within(title as HTMLElement).getByRole("button", { name: /Reset Watch/ });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("https://codex-resets.com/");
  });

  it("sizes the capsule from the visible daily ratio text", () => {
    expect(capsuleLogicalWidth(24, 1.15)).toBe(88);
    expect(capsuleLogicalWidth(118.8, 1.15)).toBe(123);
    expect(capsuleLogicalWidth(118.8, 2)).toBe(148);
  });

  it("colors only the weekly ring by the remaining-quota bands", () => {
    const snapshotAt = (remainingPercent: number): ProviderSnapshot => ({
      ...codex,
      weeklyWindow: { ...codex.weeklyWindow!, remainingPercent },
    });
    const renderFocusCard = (snapshot: ProviderSnapshot) => (
      <QuotaCard
        key={snapshot.weeklyWindow?.remainingPercent}
        snapshot={snapshot}
        snapshots={[snapshot]}
        preferences={{ ...preferences, codexFocusMode: true }}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />
    );
    const view = render(renderFocusCard(snapshotAt(50)));

    expect(screen.getByRole("group", { name: "Weekly remaining 50%" })).toHaveClass("codex-ring-card--quota-high");
    expect(screen.getByRole("group", { name: /Today's used/ }).className).not.toMatch(/codex-ring-card--quota-(high|mid|low)/);

    view.rerender(renderFocusCard(snapshotAt(49)));
    expect(screen.getByRole("group", { name: "Weekly remaining 49%" })).toHaveClass("codex-ring-card--quota-mid");

    view.rerender(renderFocusCard(snapshotAt(20)));
    expect(screen.getByRole("group", { name: "Weekly remaining 20%" })).toHaveClass("codex-ring-card--quota-mid");

    view.rerender(renderFocusCard(snapshotAt(19)));
    expect(screen.getByRole("group", { name: "Weekly remaining 19%" })).toHaveClass("codex-ring-card--quota-low");
  });

  it("compares today's use with today's guide while keeping the personal cap slider", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T08:00:00+08:00"));
    const onDailyBudgetChange = vi.fn();
    const onResetDailyBudget = vi.fn();
    try {
      render(
        <QuotaCard
          snapshot={{
            ...codex,
            plan: "PROLITE",
            resetCredits: 0,
            weeklyWindow: { remainingPercent: 74, resetsAt: "2026-07-25T00:00:00Z", windowSeconds: 604_800 },
            rateLimitSnapshot: {
              source: "app-server",
              usedPercent: 26,
              windowDurationMins: 10_080,
              resetsAt: "2026-07-25T00:00:00Z",
              observedAt: "2026-07-20T08:00:00+08:00",
            },
          }}
          snapshots={[codex]}
          preferences={{ ...preferences, codexFocusMode: true, dailyBudgetPercent: 14.3, language: "zh-CN" }}
          codexDailyUsage={{
            localDate: "2026-07-20",
            observedUsedPercent: 6,
            sampleCount: 24,
            firstObservedAt: "2026-07-20T14:24:00+08:00",
            lastObservedAt: "2026-07-20T18:00:00+08:00",
            coverage: "partial",
            source: "codex-session-rate-limits",
          }}
          paceBaselines={{
            "codex:weekly": {
              provider: "codex",
              period: "weekly",
              localDate: "2026-07-20",
              capturedAt: "2026-07-20T00:00:00Z",
              remainingPercent: 80,
              resetsAt: "2026-07-25T00:00:00Z",
              cycleStartedAt: "2026-07-18T00:00:00Z",
              cycleStartRemainingPercent: 100,
              planningResetsAt: "2026-07-25T00:00:00Z",
              resetForecastScore: null,
              resetForecastWindowHours: null,
            },
          }}
          resetForecast={{
            score: 41,
            windowHours: 24,
            fetchedAt: "2026-07-20T00:00:00Z",
            resetAnnounced: false,
            sourceUrl: "https://codex-resets.com/",
          }}
          onDailyBudgetChange={onDailyBudgetChange}
          onResetDailyBudget={onResetDailyBudget}
          onSelectProvider={noop}
          onLock={noop}
          onLanguage={noop}
          onDrag={noop}
          onHover={noop}
          consumingProviders={new Set()}
        />,
      );

      expect(screen.getByText("Codex 驾驶舱")).toBeInTheDocument();
      expect(screen.getByText("本周剩余")).toBeInTheDocument();
      expect(screen.getByText("已记录 6% · 14:24 起")).toBeInTheDocument();
      const dailyRing = screen.getByRole("group", { name: "今日已用 42%" });
      expect(dailyRing).toHaveTextContent("上限余量 8.3%");
      expect(dailyRing.querySelector(".daily-usage-track")).not.toBeInTheDocument();
      expect(dailyRing.querySelector(".codex-ring-value strong")).toHaveTextContent("42");
      expect(Number(dailyRing.querySelector(".codex-ring-progress")?.getAttribute("stroke-dasharray")?.split(" ")[0])).toBeCloseTo(42, 6);
      const weeklyRing = screen.getByRole("group", { name: "本周剩余 74%" });
      expect(weeklyRing).toHaveTextContent("下次重置");
      expect(weeklyRing).toHaveTextContent("重置机会");
      expect(weeklyRing).toHaveTextContent("暂无");
      expect(screen.queryByText("当前套餐")).not.toBeInTheDocument();
      expect(screen.queryByText("Pro Lite")).not.toBeInTheDocument();
      const slider = screen.getByRole("slider", { name: "个人上限" });
      expect(slider).toHaveValue("14.3");
      expect(screen.getByText("官方额度快照")).toBeInTheDocument();
      expect(screen.queryByText("官方 App Server")).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "官方额度快照" })).toHaveTextContent("今日总建议");
      expect(screen.queryByText("今日建议")).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "官方额度快照" }).querySelectorAll(".today-quota-advice-grid > div")).toHaveLength(3);
      expect(screen.getByRole("slider", { name: "重置风险" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "官方额度快照" }).querySelector("footer")).not.toBeInTheDocument();
      fireEvent.change(slider, { target: { value: "20.5" } });
      expect(onDailyBudgetChange).toHaveBeenCalledWith(20.5);
      fireEvent.click(screen.getByRole("button", { name: "恢复今日建议" }));
      expect(onResetDailyBudget).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("QUOTA FLOAT")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("localizes the cockpit brand in English mode", () => {
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={{ ...preferences, codexFocusMode: true, language: "en" }}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    expect(screen.getByText("Codex Cockpit")).toBeInTheDocument();
    expect(screen.queryByText("Codex 驾驶舱")).not.toBeInTheDocument();
  });

  it("restores the risk slider and lets refresh return to website following", () => {
    const onRiskChange = vi.fn();
    render(
      <QuotaCard
        snapshot={{ ...codex, rateLimitSnapshot: { source: "app-server", usedPercent: 26, windowDurationMins: 10_080, resetsAt: "2026-07-25T00:00:00Z", observedAt: "2026-07-20T08:00:00+08:00" } }}
        snapshots={[codex]}
        preferences={{ ...preferences, codexFocusMode: true, language: "zh-CN", resetRiskOverridePercent: 10 }}
        resetForecast={{ score: 18, tomorrowRiskPercent: 18, windowHours: 24, fetchedAt: "2026-07-20T00:00:00Z", resetAnnounced: false, sourceUrl: "https://codex-resets.com/" }}
        resetWatch={{ level: "elevated", resetChancePercent: 83, observedAt: "2026-07-20T00:00:00Z", expiresAt: "2026-07-23T07:00:00Z" }}
        onResetRiskChange={onRiskChange}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    fireEvent.change(screen.getByRole("slider", { name: "重置风险" }), { target: { value: "70" } });
    expect(onRiskChange).toHaveBeenLastCalledWith(70);
    fireEvent.click(screen.getByRole("button", { name: "恢复网站风险" }));
    expect(onRiskChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText(/来源 18%/)).not.toBeInTheDocument();
  });

  it("turns the daily ring red and shows the over-cap ratio", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T08:00:00+08:00"));
    try {
      render(
        <QuotaCard
          snapshot={{
            ...codex,
            weeklyWindow: { remainingPercent: 74, resetsAt: "2026-07-25T00:00:00Z", windowSeconds: 604_800 },
            rateLimitSnapshot: {
              source: "app-server",
              usedPercent: 26,
              windowDurationMins: 10_080,
              resetsAt: "2026-07-25T00:00:00Z",
              observedAt: "2026-07-20T08:00:00+08:00",
            },
          }}
          snapshots={[codex]}
          preferences={{ ...preferences, codexFocusMode: true, dailyBudgetPercent: 10, language: "zh-CN" }}
          codexDailyUsage={{
            localDate: "2026-07-20",
            observedUsedPercent: 12,
            sampleCount: 24,
            firstObservedAt: "2026-07-20T14:24:00+08:00",
            lastObservedAt: "2026-07-20T18:00:00+08:00",
            coverage: "partial",
            source: "codex-session-rate-limits",
          }}
          onDailyBudgetChange={noop}
          onSelectProvider={noop}
          onLock={noop}
          onLanguage={noop}
          onDrag={noop}
          onHover={noop}
          consumingProviders={new Set()}
        />,
      );

      const dailyRing = screen.getByRole("group", { name: "今日已用 120%" });
      expect(dailyRing).toHaveClass("codex-ring-card--over_pace");
      expect(dailyRing).toHaveTextContent("超出上限 20%");
      expect(dailyRing).toHaveTextContent("已用 12% / 总建议");
      expect(dailyRing.querySelector(".codex-ring-value strong")).toHaveTextContent("120");
      expect(Number(dailyRing.querySelector(".codex-ring-progress")?.getAttribute("stroke-dasharray")?.split(" ")[0])).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns the daily ring yellow at 80% of the personal cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T08:00:00+08:00"));
    try {
      render(
        <QuotaCard
          snapshot={{
            ...codex,
            weeklyWindow: { remainingPercent: 74, resetsAt: "2026-07-25T00:00:00Z", windowSeconds: 604_800 },
            rateLimitSnapshot: {
              source: "app-server",
              usedPercent: 26,
              windowDurationMins: 10_080,
              resetsAt: "2026-07-25T00:00:00Z",
              observedAt: "2026-07-20T08:00:00+08:00",
            },
          }}
          snapshots={[codex]}
          preferences={{ ...preferences, codexFocusMode: true, dailyBudgetPercent: 6.224, language: "zh-CN" }}
          codexDailyUsage={{
            localDate: "2026-07-20",
            observedUsedPercent: 6,
            sampleCount: 24,
            firstObservedAt: "2026-07-20T14:24:00+08:00",
            lastObservedAt: "2026-07-20T18:00:00+08:00",
            coverage: "partial",
            source: "codex-session-rate-limits",
          }}
          onDailyBudgetChange={noop}
          onSelectProvider={noop}
          onLock={noop}
          onLanguage={noop}
          onDrag={noop}
          onHover={noop}
          consumingProviders={new Set()}
        />,
      );

      const dailyRing = screen.getByRole("group", { name: "今日已用 96.4%" });
      expect(dailyRing).toHaveClass("codex-ring-card--daily-warning");
      expect(dailyRing).not.toHaveClass("codex-ring-card--over_pace");
      expect(dailyRing.querySelector(".codex-ring-value strong")).toHaveTextContent("96.4");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the card interaction-aware while the daily slider is dragged", () => {
    class TestPointerEvent extends MouseEvent {
      pointerId: number;

      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
    const onSliderInteraction = vi.fn();
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={{ ...preferences, codexFocusMode: true, dailyBudgetPercent: 14.3, language: "en" }}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        onSliderInteraction={onSliderInteraction}
        consumingProviders={new Set()}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Personal cap" });
    Object.assign(slider, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
    fireEvent.pointerDown(slider, { button: 0, pointerId: 3 });
    fireEvent.pointerUp(slider, { pointerId: 3 });

    expect(onSliderInteraction).toHaveBeenNthCalledWith(1, true);
    expect(onSliderInteraction).toHaveBeenLastCalledWith(false);
  });

  it("does not invent today's use when no official local snapshot exists", () => {
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={{ ...preferences, codexFocusMode: true, dailyBudgetPercent: 14.3, language: "zh-CN" }}
        codexDailyUsage={{
          localDate: "2026-07-20",
          observedUsedPercent: 0,
          sampleCount: 0,
          firstObservedAt: null,
          lastObservedAt: null,
          coverage: "unavailable",
          source: "codex-session-rate-limits",
        }}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    expect(screen.getByRole("group", { name: "今日已用" })).toHaveTextContent("等待今日建议");
    expect(screen.getByText("今日未记录用量")).toBeInTheDocument();
  });

  it("shows the evening feedback choices without duplicating the comfort curve", () => {
    const onComfortSelect = vi.fn();
    const prompt: ComfortPrompt = {
      localDate: "2026-07-20",
      isCatchUp: false,
      observedUsedPercent: 6,
      usageObservedAt: "2026-07-20T16:00:00.000Z",
      usageCoverage: "complete",
      usageSource: "official-snapshot",
    };
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={{ ...preferences, codexFocusMode: true, language: "zh-CN" }}
        comfortPrompt={prompt}
        onComfortSelect={onComfortSelect}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    expect(screen.getByRole("region", { name: "今天感觉？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "有点撑" }));
    expect(onComfortSelect).toHaveBeenCalledWith("overloaded");
    expect(screen.queryByRole("region", { name: "舒适曲线" })).not.toBeInTheDocument();
  });

  it("shows the live Codex reset forecast and opens its source", () => {
    const onOpenResetForecast = vi.fn();
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={preferences}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
        resetForecast={{
          score: 92,
          windowHours: 48,
          fetchedAt: "2026-07-20T18:14:26.948Z",
          resetAnnounced: false,
          sourceUrl: "https://codex-resets.com/",
        }}
        onOpenResetForecast={onOpenResetForecast}
      />,
    );

    expect(screen.getByText("48h chance · 92%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Unofficial calibrated 24h reset risk/i }));
    expect(onOpenResetForecast).toHaveBeenCalledWith("https://codex-resets.com/");
  }, 15_000);

  it("lists real platform values and selects a connected platform", () => {
    const onSelectProvider = vi.fn();
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex, qoder]}
        preferences={preferences}
        onSelectProvider={onSelectProvider}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /QODER.*1,280.*credits/i }));
    expect(onSelectProvider).toHaveBeenCalledWith("qoder");
    expect(screen.getByText("Weekly remaining")).toBeInTheDocument();
  });

  it("keeps the full-size provider-bar layout free of a duplicate slider", () => {
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex, qoder]}
        preferences={{ ...preferences, expandedLayout: "provider-bar" }}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    expect(screen.queryByRole("radiogroup", { name: "Choose provider" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /QODER.*1,280.*credits/i })).toBeInTheDocument();
  });

  it("shows risk-first values and local history trails", () => {
    const { container } = render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex, volcengine, antigravity]}
        preferences={{ ...preferences, riskFirst: true, showHistorySparklines: true }}
        history={[
          { provider: "codex", capturedAt: "2026-07-15T00:00:00Z", metric: 91, metricKind: "percent", status: "ok", resetsAt: null },
          { provider: "codex", capturedAt: "2026-07-16T00:00:00Z", metric: 74, metricKind: "percent", status: "ok", resetsAt: null },
        ]}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    expect(screen.getByText("RISK FIRST")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /VOLCENGINE.*45%.*Monthly/i })).toBeInTheDocument();
    expect(container.querySelector(".provider-history polyline")).toBeInTheDocument();
  });

  it("switches between exactly two tabs while preserving the local usage dashboard", () => {
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={preferences}
        history={[
          { provider: "codex", capturedAt: "2026-07-15T00:00:00Z", metric: 82, metricKind: "percent", status: "ok", resetsAt: "2026-07-19T00:00:00Z" },
          { provider: "codex", capturedAt: "2026-07-16T00:00:00Z", metric: 74, metricKind: "percent", status: "ok", resetsAt: "2026-07-19T00:00:00Z" },
        ]}
        dailyUsage={[{ provider: "codex", localDate: "2026-07-16", observedUsedPercent: 8, sampleCount: 3, updatedAt: "2026-07-16T00:00:00Z" }]}
        resetForecast={{
          score: 92,
          windowHours: 48,
          fetchedAt: "2026-07-20T18:14:26.948Z",
          resetAnnounced: false,
          sourceUrl: "https://codex-resets.com/",
        }}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    const quotaTab = screen.getByRole("tab", { name: "Quota" });
    const insightsTab = screen.getByRole("tab", { name: "Insights" });
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(quotaTab).toHaveAttribute("aria-selected", "true");

    fireEvent.click(insightsTab);
    expect(insightsTab).toHaveAttribute("aria-selected", "true");
    expect(quotaTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("region", { name: "Usage insights" })).toBeInTheDocument();
    expect(screen.getByText("Used this cycle")).toBeInTheDocument();
    expect(screen.getByText("Today observed")).toBeInTheDocument();
    expect(screen.getByText("Daily guide")).toBeInTheDocument();
    expect(screen.getByText("Unofficial outlook")).toBeInTheDocument();
    expect(screen.getByText("Reset outlook")).toBeInTheDocument();
    expect(screen.getByText("calibrated 48h · local fallback")).toBeInTheDocument();
    expect(screen.getByText("Last 90 days")).toBeInTheDocument();
    expect(screen.getByText(/no prompt or token content/i)).toBeInTheDocument();

    fireEvent.click(quotaTab);
    expect(quotaTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("region", { name: "Usage insights" })).not.toBeInTheDocument();

    fireEvent.keyDown(quotaTab, { key: "ArrowRight" });
    expect(insightsTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(insightsTab, { key: "ArrowLeft" });
    expect(quotaTab).toHaveAttribute("aria-selected", "true");
  });

  it("labels a short-window pace guide by the hour", () => {
    render(
      <QuotaCard
        snapshot={antigravity}
        snapshots={[antigravity]}
        preferences={preferences}
        initialInsightsOpen
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    expect(screen.getByText("Hourly guide")).toBeInTheDocument();
    expect(screen.queryByText("Daily guide")).not.toBeInTheDocument();
  });

  it("marks platforms without a collector as not detected", () => {
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex, qoder]}
        preferences={preferences}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    expect(screen.getByRole("button", { name: /VOLCENGINE.*Not detected/i })).toBeDisabled();
  });

  it("keeps a balance-based platform readable in the collapsed orb", () => {
    render(<QuotaOrb snapshot={qoder} language="en" onDrag={noop} onActivate={noop} />);
    expect(screen.getByLabelText("1280 credits")).toBeInTheDocument();
  });

  it("applies compact layout and color theme independently", () => {
    render(<QuotaOrb snapshot={codex} language="en" compactLayout="float" colorTheme="paper" resolvedAppearance="light" onDrag={noop} onActivate={noop} />);
    expect(screen.getByLabelText("Weekly quota remaining 74%")).toHaveClass("quota-card--compact-float", "quota-card--style-paper", "quota-card--theme-light");
  });

  it("renders the Ring compact layout with any color theme", () => {
    render(<QuotaOrb snapshot={codex} language="en" compactLayout="ring" colorTheme="graphite" resolvedAppearance="dark" onDrag={noop} onActivate={noop} />);
    const ring = screen.getByLabelText("Weekly quota remaining 74%");
    expect(ring).toHaveClass("quota-card--compact-ring", "quota-card--style-graphite", "quota-card--theme-dark");
    expect(ring).toHaveStyle({ "--quota-progress-angle": "266.4deg" });
  });

  it("expands the compact capsule only after an explicit click", () => {
    const onActivate = vi.fn();
    render(<QuotaOrb snapshot={codex} language="en" compactLayout="capsule" onDrag={noop} onActivate={onActivate} />);
    const capsule = screen.getByRole("button", { name: /Weekly quota remaining 74%/ });
    fireEvent.mouseEnter(capsule);
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(capsule);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("moves the compact capsule without treating the drag release as an expand click", () => {
    const onActivate = vi.fn();
    const onDrag = vi.fn();
    render(<QuotaOrb snapshot={codex} language="en" compactLayout="capsule" onDrag={onDrag} onActivate={onActivate} />);
    const capsule = screen.getByRole("button", { name: /Weekly quota remaining 74%/ });

    fireEvent.mouseDown(capsule, { button: 0, screenX: 120, screenY: 160 });
    fireEvent.click(capsule, { screenX: 148, screenY: 174 });

    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("keeps repeated Windows clicks out of the native drag loop but still hands off a real drag", () => {
    const platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    try {
      const onActivate = vi.fn();
      const onDrag = vi.fn();
      render(<QuotaOrb snapshot={codex} language="en" compactLayout="capsule" onDrag={onDrag} onActivate={onActivate} />);
      const capsule = screen.getByRole("button", { name: /Weekly quota remaining 74%/ });
      for (let i = 0; i < 3; i++) {
        fireEvent.mouseDown(capsule, { button: 0, screenX: 120, screenY: 160 });
        fireEvent.mouseMove(capsule, { buttons: 1, screenX: 122, screenY: 161 });
        fireEvent.mouseUp(capsule, { button: 0, screenX: 122, screenY: 161 });
        fireEvent.click(capsule, { screenX: 122, screenY: 161 });
      }
      expect(onDrag).not.toHaveBeenCalled();
      expect(onActivate).toHaveBeenCalledTimes(3);
      fireEvent.mouseDown(capsule, { button: 0, screenX: 120, screenY: 160 });
      fireEvent.mouseMove(capsule, { buttons: 1, screenX: 140, screenY: 160 });
      fireEvent.mouseMove(capsule, { buttons: 1, screenX: 150, screenY: 160 });
      fireEvent.click(capsule, { screenX: 150, screenY: 160 });
      expect(onDrag).toHaveBeenCalledTimes(1);
      expect(onActivate).toHaveBeenCalledTimes(3);
    } finally {
      platform.mockRestore();
    }
  });

  it("expands after a stationary native press without mistaking it for a move", () => {
    const onActivate = vi.fn();
    const onDrag = vi.fn();
    render(<QuotaOrb snapshot={codex} language="en" compactLayout="capsule" onDrag={onDrag} onActivate={onActivate} />);
    const capsule = screen.getByRole("button", { name: /Weekly quota remaining 74%/ });

    fireEvent.mouseDown(capsule, { button: 0, screenX: 120, screenY: 160 });
    fireEvent.mouseUp(capsule, { button: 0, screenX: 122, screenY: 161 });
    fireEvent.click(capsule, { screenX: 122, screenY: 161 });

    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("shows today's use-to-cap ratio inside a smoky-blue disk and weekly remaining as a banded outer ring", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T08:00:00+08:00"));
    try {
      render(
        <QuotaOrb
          snapshot={{
            ...codex,
            weeklyWindow: { remainingPercent: 74, resetsAt: "2026-07-26T07:48:00Z", windowSeconds: 604_800 },
            rateLimitSnapshot: {
              source: "app-server",
              usedPercent: 26,
              windowDurationMins: 10_080,
              resetsAt: "2026-07-26T07:48:00Z",
              observedAt: "2026-07-20T08:00:00+08:00",
            },
          }}
          dailyUsage={{
            localDate: "2026-07-20",
            observedUsedPercent: 24,
            sampleCount: 24,
            firstObservedAt: "2026-07-20T00:05:00Z",
            lastObservedAt: "2026-07-20T08:00:00+08:00",
            coverage: "complete",
            source: "codex-session-rate-limits",
          }}
          language="en"
          compactLayout="capsule"
          dailyBudgetPercent={20.2}
          onDrag={noop}
          onActivate={noop}
        />,
      );
      const capsule = screen.getByLabelText(/Weekly quota remaining 74%; Today's used \/ personal cap 118.8%/);
      expect(capsule).toHaveClass("quota-card--compact-capsule");
      expect(capsule.querySelector(".capsule-daily-disc")).toBeInTheDocument();
      expect(capsule.querySelector(".capsule-ring--remaining")).toHaveClass("capsule-ring--quota-high");
      expect(capsule.querySelector(".capsule-quota-readout")).toHaveStyle({ "--remaining-ring-angle": "266.4deg" });
      expect(capsule).toHaveStyle({ "--capsule-logical-width": "123px" });
      expect(capsule.querySelector(".capsule-quota-readout")).toHaveClass("capsule-quota-readout--over");
      expect(capsule.querySelector(".capsule-daily-value b")?.textContent).toBe("118.8%");
      expect(capsule.querySelector(".capsule-ring--actual")).not.toBeInTheDocument();
      expect(capsule.querySelector(".capsule-ring--suggested")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps the capsule outer ring to the expanded weekly remaining bands", () => {
    const snapshotAt = (remainingPercent: number): ProviderSnapshot => ({
      ...codex,
      weeklyWindow: { ...codex.weeklyWindow!, remainingPercent },
    });
    const { rerender } = render(
      <QuotaOrb snapshot={snapshotAt(50)} language="en" compactLayout="capsule" onDrag={noop} onActivate={noop} />,
    );
    const getRemainingRing = () => screen.getByRole("button").querySelector(".capsule-ring--remaining")!;

    expect(getRemainingRing()).toHaveClass("capsule-ring--quota-high");
    rerender(<QuotaOrb snapshot={snapshotAt(49)} language="en" compactLayout="capsule" onDrag={noop} onActivate={noop} />);
    expect(getRemainingRing()).toHaveClass("capsule-ring--quota-mid");
    rerender(<QuotaOrb snapshot={snapshotAt(20)} language="en" compactLayout="capsule" onDrag={noop} onActivate={noop} />);
    expect(getRemainingRing()).toHaveClass("capsule-ring--quota-mid");
    rerender(<QuotaOrb snapshot={snapshotAt(19)} language="en" compactLayout="capsule" onDrag={noop} onActivate={noop} />);
    expect(getRemainingRing()).toHaveClass("capsule-ring--quota-low");
  });

  it("turns the capsule disk yellow at 80% daily use-to-cap ratio and red above 100%", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T08:00:00+08:00"));
    const dailyUsage = (observedUsedPercent: number): CodexDailyUsage => ({
      localDate: "2026-07-20",
      observedUsedPercent,
      sampleCount: 24,
      firstObservedAt: "2026-07-20T00:05:00Z",
      lastObservedAt: "2026-07-20T08:00:00+08:00",
      coverage: "complete",
      source: "codex-session-rate-limits",
    });
    try {
      const { rerender } = render(
        <QuotaOrb snapshot={codex} dailyUsage={dailyUsage(79.9)} dailyBudgetPercent={100} language="en" compactLayout="capsule" onDrag={noop} onActivate={noop} />,
      );
      const getReadout = () => screen.getByRole("button").querySelector(".capsule-quota-readout")!;
      expect(getReadout()).toHaveClass("capsule-quota-readout--normal");
      expect(getReadout()).toHaveTextContent("79.9%");

      rerender(<QuotaOrb snapshot={codex} dailyUsage={dailyUsage(80)} dailyBudgetPercent={100} language="en" compactLayout="capsule" onDrag={noop} onActivate={noop} />);
      expect(getReadout()).toHaveClass("capsule-quota-readout--warning");
      expect(getReadout()).toHaveTextContent("80%");

      rerender(<QuotaOrb snapshot={codex} dailyUsage={dailyUsage(120)} dailyBudgetPercent={100} language="en" compactLayout="capsule" onDrag={noop} onActivate={noop} />);
      expect(getReadout()).toHaveClass("capsule-quota-readout--over");
      expect(getReadout()).toHaveTextContent("120%");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the Stacked expanded layout independently from color", () => {
    const { container } = render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex, qoder]}
        preferences={{ ...preferences, expandedLayout: "stacked", colorTheme: "paper" }}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );
    expect(container.querySelector(".quota-card")).toHaveClass("quota-card--expanded-stacked", "quota-card--style-paper");
  });

  it("switches providers from the compact Island slider without expanding", () => {
    const onSelectProvider = vi.fn();
    const onActivate = vi.fn();
    render(
      <QuotaIsland
        snapshot={codex}
        snapshots={[codex, qoder, trae, antigravity]}
        language="en"
        onSelectProvider={onSelectProvider}
        onDrag={noop}
        onActivate={onActivate}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "QODER" }));
    expect(onSelectProvider).toHaveBeenCalledWith("qoder");
    expect(onActivate).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/CODEX 74% left On track/i)).toHaveClass("quota-card--compact-bar", "quota-card--style-aurora");
    expect(screen.getByText("74%")).toBeInTheDocument();
    expect(screen.getByText("On track")).toBeInTheDocument();
  });

  it("expands the Island only after an explicit click", () => {
    const onActivate = vi.fn();
    render(
      <QuotaIsland
        snapshot={codex}
        snapshots={[codex, qoder]}
        language="en"
        onSelectProvider={noop}
        onDrag={noop}
        onActivate={onActivate}
      />,
    );
    const island = screen.getByLabelText(/CODEX 74% left On track/i);
    fireEvent.mouseEnter(island);
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(island);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("returns the collapsed orb to idle after a hover ends", () => {
    vi.useFakeTimers();
    render(<QuotaOrb snapshot={qoder} language="en" onDrag={noop} onActivate={noop} />);
    const orb = screen.getByLabelText("1280 credits");
    fireEvent.mouseEnter(orb);
    fireEvent.mouseLeave(orb);
    expect(orb).not.toHaveClass("quota-orb--idle");
    act(() => vi.advanceTimersByTime(2000));
    expect(orb).toHaveClass("quota-orb--idle");
  });

  it("keeps the Codex weekly design and adds a compact pace hint only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    try {
      const weeklyOnlyCodex: ProviderSnapshot = {
        ...codex,
        shortWindow: { remainingPercent: 5, resetsAt: "2026-07-20T05:00:00Z", windowSeconds: 18_000 },
        weeklyWindow: { remainingPercent: 74, resetsAt: "2026-07-25T00:00:00Z", windowSeconds: 604_800 },
      };
      render(
        <QuotaCard
          snapshot={weeklyOnlyCodex}
          snapshots={[weeklyOnlyCodex]}
          preferences={preferences}
          onSelectProvider={noop}
          onLock={noop}
          onLanguage={noop}
          onDrag={noop}
          onHover={noop}
          consumingProviders={new Set()}
        />,
      );
      expect(screen.getByText("Weekly remaining")).toBeInTheDocument();
      expect(screen.getByText("On track")).toBeInTheDocument();
      expect(screen.getByText("Used since reset: 26%")).toBeInTheDocument();
      expect(screen.getByText(/Today's plan: [\d.]+% left/)).toBeInTheDocument();
      expect(screen.getByText("Daily suggestion ≤ 14.8%/day")).toBeInTheDocument();
      expect(screen.queryByText("5 hours")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains when a balance quota has no period for pace guidance", () => {
    render(
      <QuotaCard
        snapshot={qoder}
        snapshots={[qoder]}
        preferences={preferences}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );
    expect(screen.getByText("Pace needs a quota period")).toBeInTheDocument();
  });

  it("shows TRAE's credit balance in the collapsed orb", () => {
    render(<QuotaOrb snapshot={trae} language="en" onDrag={noop} onActivate={noop} />);
    expect(screen.getByLabelText("350 credits")).toBeInTheDocument();
  });

  it("shows Antigravity's short-window quota in the collapsed orb", () => {
    render(<QuotaOrb snapshot={antigravity} language="en" onDrag={noop} onActivate={noop} />);
    expect(screen.getByLabelText("5 hours quota remaining 68%")).toBeInTheDocument();
    expect(screen.getByText("68")).toBeInTheDocument();
  });

  it("offers an in-app reconnect action for an expired Volcengine login", () => {
    const onReconnect = vi.fn();
    render(
      <QuotaCard
        snapshot={signedOutVolcengine}
        snapshots={[signedOutVolcengine]}
        preferences={preferences}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        onReconnect={onReconnect}
        consumingProviders={new Set()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(screen.getByText("Reconnect VOLCENGINE")).toBeInTheDocument();
  });

  it("shows Volcengine 5-hour, weekly, and monthly pace guidance", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    try {
      render(
        <QuotaCard
          snapshot={volcengine}
          snapshots={[volcengine]}
          preferences={preferences}
          onSelectProvider={noop}
          onLock={noop}
          onLanguage={noop}
          onDrag={noop}
          onHover={noop}
          consumingProviders={new Set()}
        />,
      );

      expect(screen.getByRole("region", { name: "Quota windows" })).toHaveTextContent("5 hours");
      expect(screen.getByRole("region", { name: "Quota windows" })).toHaveTextContent("Weekly");
      expect(screen.getByRole("region", { name: "Quota windows" })).toHaveTextContent("Monthly");
      expect(screen.getAllByText(/Today's plan: [\d.]+% left/)).toHaveLength(3);
      expect(screen.getByText("Daily suggestion ≤ 30%/hour")).toBeInTheDocument();
      expect(screen.getByText(/Over pace \+[\d.]+%/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows only redacted Volcengine diagnostics", () => {
    render(
      <QuotaCard
        snapshot={signedOutVolcengine}
        snapshots={[signedOutVolcengine]}
        preferences={preferences}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        diagnostics={diagnostics}
        diagnosticsOpen
        consumingProviders={new Set()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Volcengine connection" })).toBeInTheDocument();
    expect(screen.getByText(/~\\AppData\\Roaming\\npm\\arkcli\.cmd/)).toBeInTheDocument();
    expect(screen.queryByText(/refresh_token|ark-[a-z0-9]{8}/i)).not.toBeInTheDocument();
  });

  it("keeps a downloaded update ready until the user chooses to restart", () => {
    const onUpdateInstall = vi.fn();
    const onUpdateLater = vi.fn();
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={preferences}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
        updateOpen
        updateState={{
          phase: "ready",
          info: { version: "0.2.0", body: "Background updates.", date: null, platform: "windows", channel: "stable", releaseUrl: "https://github.com/silverlion2/quota-float/releases/latest", automaticInstall: true },
          progress: { downloadedBytes: 100, totalBytes: 100, percent: 100 },
          error: null,
        }}
        onUpdateInstall={onUpdateInstall}
        onUpdateLater={onUpdateLater}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Codex Cockpit update" })).toHaveTextContent("0.2.0 is ready");
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onUpdateLater).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Restart and install/i }));
    expect(onUpdateInstall).toHaveBeenCalledOnce();
  });

  it("shows when the current Codex window recently reset", () => {
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex]}
        preferences={preferences}
        onSelectProvider={noop}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
        recentCodexReset={{ detectedAt: "2026-07-18T01:00:00Z", resetAt: "2026-07-18T01:00:00Z", source: "window" }}
      />,
    );

    expect(screen.getByText("Recently reset")).toBeInTheDocument();
  });

  it("reorders quota rows by dragging the grip and preserves the resulting order", () => {
    class TestPointerEvent extends MouseEvent {
      pointerId: number;

      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
    const onReorderProviders = vi.fn();
    const onWindowDrag = vi.fn();
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex, qoder]}
        preferences={preferences}
        onSelectProvider={noop}
        onReorderProviders={onReorderProviders}
        onLock={noop}
        onLanguage={noop}
        onDrag={onWindowDrag}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    const codexRow = screen.getByRole("listitem", { name: /Reorder CODEX/i });
    const traeRow = screen.getByRole("listitem", { name: /Reorder TRAE/i });
    vi.spyOn(traeRow, "getBoundingClientRect").mockReturnValue({ top: 0, height: 20 } as DOMRect);
    const elementFromPoint = vi.fn(() => traeRow);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });
    const codexGrip = screen.getByRole("button", { name: /Reorder CODEX/i });

    fireEvent.mouseDown(codexGrip, { button: 0 });
    expect(onWindowDrag).not.toHaveBeenCalled();
    fireEvent.pointerDown(codexGrip, { button: 0, pointerId: 1, clientY: 1 });
    expect(codexRow).toHaveClass("is-dragging");
    fireEvent.pointerMove(codexGrip, { pointerId: 1, clientY: 1 });
    expect(traeRow).toHaveClass("is-drag-target");
    fireEvent.pointerUp(codexGrip, { pointerId: 1, clientY: 1 });

    expect(onReorderProviders).toHaveBeenCalledWith(["qoder", "codex", "trae", "workbuddy", "volcengine", "antigravity"]);
  });

  it("supports Alt plus arrow keys as a sorting alternative", () => {
    const onReorderProviders = vi.fn();
    render(
      <QuotaCard
        snapshot={codex}
        snapshots={[codex, qoder]}
        preferences={preferences}
        onSelectProvider={noop}
        onReorderProviders={onReorderProviders}
        onLock={noop}
        onLanguage={noop}
        onDrag={noop}
        onHover={noop}
        consumingProviders={new Set()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("listitem", { name: /Reorder CODEX/i }), { key: "ArrowDown", altKey: true });
    expect(onReorderProviders).toHaveBeenCalledWith(["qoder", "codex", "trae", "workbuddy", "volcengine", "antigravity"]);
  });
});
