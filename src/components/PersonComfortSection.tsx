import type { TokeiUsage } from "../lib/tokeiUsage";
import { useMemo } from "react";
import { buildComfortPrompt, personalizeComfortCurve } from "../lib/comfortFeedback";
import { personalFeedbackView } from "../lib/personComfort";
import { buildPersonQuotaAllocation } from "../lib/personQuotaAllocation";
import type { CodexDailyUsage, ComfortCode, ComfortFeedbackRecord, ComfortQuotaAllocation, DailyUsageSummary, Language } from "../types";
import { ComfortHistoryCalendar } from "./ComfortHistoryCalendar";
import { ComfortCurvePanel } from "./ComfortCurvePanel";

export function PersonComfortSection({ data, personId, records, language, dailyUsageHistory = [], dailyUsage = [], curve: sharedCurve, loadingError = false, saving = false, error = null, onPersonChange, onChange, onRefreshSnapshot }: {
  data: TokeiUsage | null; personId: string | null; records: readonly ComfortFeedbackRecord[]; language: Language;
  curve?: ReturnType<typeof personalizeComfortCurve>;
  dailyUsageHistory?: readonly CodexDailyUsage[]; dailyUsage?: readonly DailyUsageSummary[];
  loadingError?: boolean; saving?: boolean; error?: string | null;
  onPersonChange: (id: string | null) => void;
  onChange: (date: string, comfort: ComfortCode) => void;
  onRefreshSnapshot: (date: string) => void;
}) {
  const zh = language !== "en";
  const selected = data?.groups.find(group => group.id === personId);
  const ownRecords = useMemo(() => records.filter(record => (record.personId ?? null) === personId).map(record => personalFeedbackView(record, data, dailyUsageHistory, dailyUsage)), [records, personId, data, dailyUsageHistory, dailyUsage]);
  const curve = useMemo(() => sharedCurve ?? personalizeComfortCurve(ownRecords), [sharedCurve, ownRecords]);
  const percentByDate = useMemo(() => {
    const result: Record<string, ComfortQuotaAllocation> = {};
    if (!personId || !data) return result;
    const dates = new Set([...dailyUsageHistory.map(day => day.localDate), ...dailyUsage.filter(day => day.provider === "codex").map(day => day.localDate)]);
    for (const date of dates) {
      const total = buildComfortPrompt({ localDate: date, isCatchUp: true }, dailyUsageHistory.find(day => day.localDate === date) ?? null, dailyUsage);
      const allocation = buildPersonQuotaAllocation(data, personId, date, total);
      if (allocation) result[date] = allocation;
    }
    return result;
  }, [data, personId, dailyUsageHistory, dailyUsage]);
  const legacyCount = records.filter(record => !record.personId).length;
  const orphans = new Map<string, string>();
  for (const record of records) if (record.personId && !data?.groups.some(group => group.id === record.personId)) orphans.set(record.personId, record.personName || record.personId);
  const personSelector = <div className="comfort-person-toolbar">
      <select id="comfort-person-select" aria-label={zh ? "谁的体验" : "Whose experience"} title={zh ? "谁的体验" : "Whose experience"} value={personId ?? ""} disabled={saving} onChange={event => onPersonChange(event.target.value || null)}>
        {data?.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        {[...orphans].map(([id, name]) => <option key={id} value={id}>{name} · {zh ? "历史分组" : "Archived group"}</option>)}
        <option value="">{zh ? "未归属旧记录" : "Unassigned legacy"}{legacyCount ? ` (${legacyCount})` : ""}</option>
      </select>
    </div>;
  return <div className="person-comfort-section">
    {!selected && <p className="comfort-person-note">{personId ? (zh ? "历史分组" : "Archived group") : (zh ? "旧记录未归属" : "Unassigned legacy entries")}</p>}
    {loadingError && <p className="comfort-person-note" role="status">{zh ? "用量刷新失败，暂保留上次快照；新记录标为不完整。" : "Usage refresh failed; cached data is retained and new snapshots are partial."}</p>}
    {!data && !loadingError && <p className="comfort-person-note" role="status">{zh ? "正在读取用户分组与日账…" : "Loading people and daily usage…"}</p>}
    {error && <p className="comfort-person-error" role="alert">{error}</p>}
    <ComfortCurvePanel curve={curve} language={language} estimated={Boolean(personId)} personSelector={personSelector} />
    <ComfortHistoryCalendar key={personId ?? "legacy"} personPercentMode percentByDate={percentByDate} personId={selected ? personId : null} usageData={data} records={ownRecords} language={language} onChange={onChange} saving={saving} onRefreshSnapshot={selected ? onRefreshSnapshot : undefined} />
  </div>;
}
