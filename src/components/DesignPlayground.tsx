import { useMemo, useState, type CSSProperties } from "react";
import type { ColorTheme, CompactLayout, DailyUsageSummary, ExpandedLayout, ProviderId, ProviderSnapshot, QuotaHistoryPoint, ResetForecast, ResolvedAppearance, WidgetPreferences } from "../types";
import { QuotaCard, QuotaIsland, QuotaOrb } from "./QuotaCard";
import type { UpdateViewState } from "./UpdatePanel";
import { DEFAULT_WIDGET_PREFERENCES } from "../lib/preferences";

const preview: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: { remainingPercent: 74, resetsAt: new Date(Date.now() + 3.2 * 86_400_000).toISOString(), windowSeconds: 604_800 },
  resetCredits: 1,
  resetCreditExpiresAt: [new Date(Date.now() + 9 * 86_400_000).toISOString()],
  updatedAt: new Date().toISOString(),
  status: "ok",
  message: null,
};
const preferences: WidgetPreferences = { ...DEFAULT_WIDGET_PREFERENCES, pinnedProvider: "codex", language: "en" };
const sortedPreferences: WidgetPreferences = { ...preferences, providerOrder: ["qoder", "codex", "trae", "workbuddy", "volcengine", "antigravity"] };
const peerPreviews: ProviderSnapshot[] = [{
  provider: "qoder", displayName: "QODER", plan: "PRO", shortWindow: null, weeklyWindow: null,
  resetCredits: null, balanceRemaining: 1280, balanceUnit: "credits", updatedAt: new Date().toISOString(), status: "ok", message: null,
}, {
  provider: "trae", displayName: "TRAE", plan: "Pro", shortWindow: null, weeklyWindow: null,
  resetCredits: null, balanceRemaining: 350, balanceUnit: "credits", updatedAt: new Date().toISOString(), status: "ok", message: null,
}, {
  provider: "workbuddy", displayName: "WORKBUDDY", plan: null, shortWindow: null, weeklyWindow: null,
  resetCredits: null, balanceRemaining: 420, balanceUnit: "credits", updatedAt: new Date().toISOString(), status: "ok", message: null,
}, {
  provider: "volcengine", displayName: "VOLCENGINE", plan: "CODING",
  shortWindow: { remainingPercent: 88, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), windowSeconds: 18_000 },
  weeklyWindow: { remainingPercent: 86, resetsAt: new Date(Date.now() + 5.4 * 86_400_000).toISOString(), windowSeconds: 604_800 },
  monthlyWindow: { remainingPercent: 45, resetsAt: new Date(Date.now() + 20.4 * 86_400_000).toISOString(), windowSeconds: 31 * 86_400 },
  resetCredits: null, updatedAt: new Date().toISOString(), status: "ok", message: null,
}, {
  provider: "antigravity", displayName: "ANTIGRAVITY", plan: "Google AI Pro",
  shortWindow: { remainingPercent: 68, resetsAt: new Date(Date.now() + 4 * 3_600_000).toISOString(), windowSeconds: 18_000 },
  weeklyWindow: null, resetCredits: null, updatedAt: new Date().toISOString(), status: "ok", message: null,
}];
const noConsumingProviders = new Set<string>();
const codexConsuming = new Set<string>(["codex"]);
const noop = () => undefined;
const noSelect = (_provider: ProviderId) => undefined;
const previewHistory: QuotaHistoryPoint[] = [96, 91, 89, 81, 79, 74].map((metric, index) => ({
  provider: "codex",
  capturedAt: new Date(Date.now() - (5 - index) * 30 * 60_000).toISOString(),
  metric,
  metricKind: "percent",
  status: "ok",
  resetsAt: preview.weeklyWindow?.resetsAt ?? null,
}));
const previewDailyUsage: DailyUsageSummary[] = Array.from({ length: 90 }, (_, index) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - (89 - index));
  const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const active = index % 5 !== 0 && index % 7 !== 0;
  return {
    provider: "codex" as const,
    localDate,
    observedUsedPercent: active ? 2 + ((index * 7) % 22) : 0,
    sampleCount: active ? 8 : 2,
    updatedAt: date.toISOString(),
  };
});
const previewResetForecast: ResetForecast = {
  score: 62,
  windowHours: 48,
  fetchedAt: new Date().toISOString(),
  resetAnnounced: false,
  resetAt: null,
  sourceUrl: "https://codex-resets.com/",
};

const readyUpdate: UpdateViewState = {
  phase: "ready",
  info: {
    version: "0.2.0",
    body: "Background downloads, a clearer update status, and one-command releases.",
    date: new Date().toISOString(),
    platform: "windows",
    channel: "stable",
    releaseUrl: "https://github.com/silverlion2/quota-float/releases/latest",
    automaticInstall: true,
  },
  progress: { downloadedBytes: 100, totalBytes: 100, percent: 100 },
  error: null,
};

function previewSnapshots(active: ProviderSnapshot): ProviderSnapshot[] {
  return [active, ...peerPreviews];
}

interface Values {
  radius: number;
  numberSize: number;
  progressHeight: number;
  brightness: number;
  motion: number;
  cool: string;
  glow: string;
  warm: string;
}

type PreviewMode = 74 | 35 | 8 | "unavailable" | "stale" | "signed_out" | "orb";

const previewModes: Array<{ value: PreviewMode; label: string }> = [
  { value: 74, label: "74% Healthy" },
  { value: 35, label: "35% Caution" },
  { value: 8, label: "8% Critical" },
  { value: "unavailable", label: "Unavailable" },
  { value: "stale", label: "Stale" },
  { value: "signed_out", label: "Signed out" },
  { value: "orb", label: "Orb" },
];

const defaults: Values = { radius: 28, numberSize: 50, progressHeight: 4, brightness: 100, motion: 18, cool: "#7188bd", glow: "#fff4c3", warm: "#ff7653" };

function initialPreviewMode(): PreviewMode {
  const mode = new URLSearchParams(window.location.search).get("mode");
  if (mode === "healthy") return 74;
  if (mode === "caution") return 35;
  if (mode === "critical") return 8;
  if (mode === "unavailable" || mode === "stale" || mode === "signed_out" || mode === "orb") return mode;
  return 74;
}

export function DesignPlayground() {
  const [values, setValues] = useState(defaults);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => initialPreviewMode());
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>("codex");
  const params = new URLSearchParams(window.location.search);
  const previewVariant = params.get("preview") ?? "";
  const screenshotMode = params.has("shot") || previewVariant.includes("shot");
  const shotKind = params.get("shot");
  const captureMode = params.has("capture");
  const showCreditTip = params.has("creditTip");
  const visualParam = params.get("visual") ?? (previewVariant.includes("graphite") ? "graphite" : previewVariant.includes("paper") ? "paper" : "aurora");
  const compactParam = params.get("compact");
  const compactLayout: CompactLayout = compactParam === "bar" || compactParam === "ring" || compactParam === "float"
    ? compactParam
    : visualParam === "island" ? "bar" : "float";
  const expandedParam = params.get("expanded");
  const expandedLayout: ExpandedLayout = expandedParam === "provider-bar" || expandedParam === "stacked" || expandedParam === "dashboard"
    ? expandedParam
    : visualParam === "island" ? "provider-bar" : "dashboard";
  const themeParam = params.get("theme") ?? visualParam;
  const colorTheme: ColorTheme = themeParam === "graphite" || themeParam === "paper" ? themeParam : "aurora";
  const resolvedAppearance: ResolvedAppearance = params.get("appearance") === "dark" ? "dark" : "light";
  const activePreferences: WidgetPreferences = {
    ...preferences,
    compactLayout,
    expandedLayout,
    colorTheme,
    appearanceMode: resolvedAppearance,
    riskFirst: params.has("risk") || previewVariant.includes("risk"),
    showHistorySparklines: true,
  };
  const style = useMemo(() => ({
    "--card-radius": `${values.radius}px`,
    "--number-size": `${values.numberSize}px`,
    "--progress-height": `${values.progressHeight}px`,
    "--card-brightness": `${values.brightness}%`,
    "--motion-duration": `${values.motion}s`,
    "--cool": values.cool,
    "--glow": values.glow,
    "--warm": values.warm,
  }) as CSSProperties, [values]);

  const makePreview = (mode: PreviewMode): ProviderSnapshot => {
    if (mode === "orb") return preview;
    if (typeof mode === "number") {
      return { ...preview, weeklyWindow: preview.weeklyWindow ? { ...preview.weeklyWindow, remainingPercent: mode } : null };
    }
    if (mode === "stale") {
      return { ...preview, status: "stale", updatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), message: "Refresh failed. Please try again later." };
    }
    return {
      ...preview,
      status: mode,
      shortWindow: null,
      weeklyWindow: null,
      resetCredits: null,
      message: mode === "signed_out" ? "Codex sign-in expired. Please sign in again." : "Quota is temporarily unavailable. It will retry in 30 seconds.",
    };
  };

  const activePreview = useMemo<ProviderSnapshot>(() => makePreview(previewMode), [previewMode]);
  const activeSnapshots = useMemo(() => previewSnapshots(activePreview), [activePreview]);
  const displayedPreview = activeSnapshots.find((snapshot) => snapshot.provider === selectedProvider) ?? activePreview;

  const update = <K extends keyof Values>(key: K, value: Values[K]) => setValues((current) => ({ ...current, [key]: value }));

  if (screenshotMode) {
    if (shotKind === "states") {
      return (
        <div className="screenshot-stage screenshot-stage--states" style={style}>
          {[74, 35, 8].map((mode) => (
            <div className="design-card-frame" key={mode}>
              <QuotaCard snapshot={makePreview(mode as PreviewMode)} snapshots={previewSnapshots(makePreview(mode as PreviewMode))} preferences={activePreferences} resolvedAppearance={resolvedAppearance} history={previewHistory} onSelectProvider={noSelect} onLock={noop} onToggleStayExpanded={noop} onLanguage={noop} onDrag={noop} onHover={noop} isConsuming={mode === 35} consumingProviders={mode === 35 ? codexConsuming : noConsumingProviders} />
            </div>
          ))}
        </div>
      );
    }

    if (shotKind === "update-ready") {
      return (
        <div className="screenshot-stage" style={style}>
          <div className="design-card-frame">
            <QuotaCard snapshot={preview} snapshots={previewSnapshots(preview)} preferences={activePreferences} resolvedAppearance={resolvedAppearance} history={previewHistory} onSelectProvider={noSelect} onLock={noop} onToggleStayExpanded={noop} onLanguage={noop} onDrag={noop} onHover={noop} consumingProviders={noConsumingProviders} updateOpen updateState={readyUpdate} />
          </div>
        </div>
      );
    }

    if (shotKind === "usage-insights") {
      return (
        <div className={`screenshot-stage screenshot-stage--insights${captureMode ? " screenshot-stage--capture" : ""}`} style={style}>
          <div className="design-card-frame">
            <QuotaCard snapshot={preview} snapshots={previewSnapshots(preview)} preferences={activePreferences} resolvedAppearance={resolvedAppearance} history={previewHistory} dailyUsage={previewDailyUsage} resetForecast={previewResetForecast} initialInsightsOpen onSelectProvider={noSelect} onLock={noop} onToggleStayExpanded={noop} onLanguage={noop} onDrag={noop} onHover={noop} consumingProviders={noConsumingProviders} />
          </div>
        </div>
      );
    }

    if (shotKind === "reset-sort") {
      return (
        <div className="screenshot-stage" style={style}>
          <div className="design-card-frame">
            <QuotaCard snapshot={preview} snapshots={previewSnapshots(preview)} preferences={{ ...sortedPreferences, compactLayout, expandedLayout, colorTheme, appearanceMode: resolvedAppearance, riskFirst: activePreferences.riskFirst }} resolvedAppearance={resolvedAppearance} history={previewHistory} onSelectProvider={noSelect} onReorderProviders={noop} onLock={noop} onToggleStayExpanded={noop} onLanguage={noop} onDrag={noop} onHover={noop} consumingProviders={noConsumingProviders} recentCodexReset={{ detectedAt: new Date().toISOString(), resetAt: new Date().toISOString(), source: "window" }} />
          </div>
        </div>
      );
    }

    return (
      <div className={`screenshot-stage${previewMode === "orb" && compactLayout === "bar" ? " screenshot-stage--island" : ""}${captureMode ? " screenshot-stage--capture" : ""}`} style={style}>
        <div className={previewMode === "orb" ? compactLayout === "bar" ? "design-island-frame" : "design-orb-frame" : "design-card-frame"}>
          {previewMode === "orb"
            ? compactLayout === "bar"
              ? <QuotaIsland snapshot={displayedPreview} snapshots={activeSnapshots} language="en" colorTheme={colorTheme} accentColor={activePreferences.accentColor} resolvedAppearance={resolvedAppearance} onSelectProvider={setSelectedProvider} onDrag={noop} onActivate={noop} />
              : <QuotaOrb snapshot={activePreview} language="en" compactLayout={compactLayout} colorTheme={colorTheme} accentColor={activePreferences.accentColor} resolvedAppearance={resolvedAppearance} onDrag={() => {}} onActivate={() => {}} />
            : <QuotaCard snapshot={displayedPreview} snapshots={activeSnapshots} preferences={activePreferences} resolvedAppearance={resolvedAppearance} history={previewHistory} dailyUsage={previewDailyUsage} resetForecast={previewResetForecast} onSelectProvider={setSelectedProvider} onLock={noop} onToggleStayExpanded={noop} onLanguage={noop} onDrag={noop} onHover={noop} consumingProviders={noConsumingProviders} initialShowCreditTip={showCreditTip} />}
        </div>
      </div>
    );
  }

  return (
    <div className="design-workbench">
      <section className="design-stage" style={style}>
        <div className="design-preview-switch" aria-label="Quota status preview">
          {previewModes.map((mode) => (
            <button key={mode.value} className={previewMode === mode.value ? "is-active" : ""} onClick={() => setPreviewMode(mode.value)}>{mode.label}</button>
          ))}
        </div>
        <div className={previewMode === "orb" ? compactLayout === "bar" ? "design-island-frame" : "design-orb-frame" : "design-card-frame"}>
          {previewMode === "orb"
            ? compactLayout === "bar"
              ? <QuotaIsland snapshot={displayedPreview} snapshots={activeSnapshots} colorTheme={colorTheme} accentColor={activePreferences.accentColor} resolvedAppearance={resolvedAppearance} onSelectProvider={setSelectedProvider} onDrag={noop} onActivate={noop} />
              : <QuotaOrb snapshot={activePreview} compactLayout={compactLayout} colorTheme={colorTheme} accentColor={activePreferences.accentColor} resolvedAppearance={resolvedAppearance} onDrag={() => {}} onActivate={() => {}} />
            : <QuotaCard snapshot={displayedPreview} snapshots={activeSnapshots} preferences={activePreferences} resolvedAppearance={resolvedAppearance} history={previewHistory} dailyUsage={previewDailyUsage} resetForecast={previewResetForecast} onSelectProvider={setSelectedProvider} onLock={noop} onToggleStayExpanded={noop} onLanguage={noop} onDrag={noop} onHover={noop} consumingProviders={noConsumingProviders} />}
        </div>
      </section>
      <aside className="design-controls">
        <div>
          <p className="design-kicker">QUOTA FLOAT</p>
          <h1>Visual Tuning</h1>
          <p className="design-description">Preview changes live, then apply the chosen values to the desktop widget.</p>
        </div>
        <Range label="Radius" value={values.radius} min={24} max={64} unit="px" onChange={(v) => update("radius", v)} />
        <Range label="Main number" value={values.numberSize} min={42} max={72} unit="px" onChange={(v) => update("numberSize", v)} />
        <Range label="Progress" value={values.progressHeight} min={3} max={8} unit="px" onChange={(v) => update("progressHeight", v)} />
        <Range label="Brightness" value={values.brightness} min={70} max={125} unit="%" onChange={(v) => update("brightness", v)} />
        <Range label="Motion" value={values.motion} min={6} max={40} unit="s" onChange={(v) => update("motion", v)} />
        <div className="color-row">
          <Color label="Cool" value={values.cool} onChange={(v) => update("cool", v)} />
          <Color label="Glow" value={values.glow} onChange={(v) => update("glow", v)} />
          <Color label="Warm" value={values.warm} onChange={(v) => update("warm", v)} />
        </div>
        <button className="reset-design" onClick={() => setValues(defaults)}>Reset design</button>
      </aside>
    </div>
  );
}

function Range({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  return <label className="range-control"><span>{label}<output>{value}{unit}</output></span><input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="color-control"><input type="color" value={value} onChange={(event) => onChange(event.target.value)} /><span>{label}</span></label>;
}
