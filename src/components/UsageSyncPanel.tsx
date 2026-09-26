import { useEffect, useRef, useState } from "react";
import { getUsageSyncStatus, saveUsageSyncSettings, syncUsageNow, type UsageSyncSettings, type UsageSyncStatus } from "../lib/usageSyncBridge";
import type { TokeiDevice } from "../lib/tokeiUsage";
import { getPreferences } from "../lib/bridge";
import { savePersonPlan, planDateKey } from "../lib/personPlanSync";

const timestamp = (value: string | null | undefined, zh: boolean) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : (zh ? "尚无记录" : "No record");
function errorText(code: string | null, zh: boolean): string {
  if (!code) return "";
  if (/shared_settings/.test(code)) return zh ? "人员分组或计划配置存在冲突或无效数据，已保留现有设置。请检查后重试。" : "Shared groups or plans have a conflict or invalid data; current settings are preserved.";
  if (/comfort/.test(code)) return zh ? "体验记录未通过同步检查，原记录已保留，请重试或检查备份。" : "Comfort records could not be synchronized; existing records are preserved. Retry or check the backup.";
  if (/busy/.test(code)) return zh ? "同步正在进行，请稍后。" : "Sync is already running.";
  if (/dirty|conflict|diverg|non.?fast|ahead|pending/.test(code)) return zh ? "同步仓库有未完成更改或冲突，已保留现场，未覆盖。" : "Pending changes or a conflict; existing data was preserved.";
  if (/collector|history|snapshot/.test(code)) return zh ? "本机采集尚未得到可发布的数据，已有快照保留。" : "Collection is not ready to publish; existing snapshots remain.";
  if (/settings|identity/.test(code)) return zh ? "请检查同步设置；已启用的设备身份与仓库不能直接替换。" : "Check settings; an established device/repository identity cannot be replaced.";
  if (/unsafe|invalid|symlink/.test(code)) return zh ? "同步目标未通过安全检查，未执行写入。" : "The sync target failed safety checks; no write was performed.";
  return zh ? "同步未完成，请检查网络及本机 Git / SSH 访问。已有数据保留。" : "Sync failed. Check networking and local Git/SSH access; existing data is retained.";
}
export function UsageSyncPanel({ zh, devices, onSynced }: { zh: boolean; devices: TokeiDevice[]; onSynced: () => void }) {
  const [status, setStatus] = useState<UsageSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<UsageSyncSettings>({ enabled: false, intervalSeconds: 300, deviceId: "", remote: "", branch: "main" });
  const mounted = useRef(false);
  const operation = useRef(false);
  useEffect(() => {
    mounted.current = true; let active = true;
    async function refresh() {
      if (operation.current) return;
      try { const next = await getUsageSyncStatus(); if (active && !operation.current) { setStatus(next); setError(null); } }
      catch { if (active) setError("sync_status_unavailable"); }
    }
    void refresh(); const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5000);
    return () => { active = false; mounted.current = false; window.clearInterval(timer); };
  }, []);
  async function action(run: () => Promise<UsageSyncStatus>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null);
    try { const next = await run(); if (mounted.current) { setStatus(next); onSynced(); } }
    catch (e) { if (mounted.current) setError(typeof e === "string" ? e : "sync_failed"); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  const working = busy || status?.phase === "running";
  const settings = status?.settings;
  const failure = error ?? status?.lastError ?? null;
  return <details className="usage-sync-panel">
    <summary>{zh ? "同步" : "Sync"} · {working ? (zh ? "进行中" : "Running") : failure ? (zh ? "需检查" : "Needs attention") : settings?.enabled ? (zh ? "自动" : "Automatic") : (zh ? "未启用自动" : "Automatic off")}</summary>
    <div className="usage-sync-body">
      <p className="usage-note">{zh ? "同步用量、体验记录、人员分组与手动计划额度 · 不含对话、凭据或窗口设置" : "Sync usage, comfort, person groups and manual plans · No conversations, credentials or window settings"}</p>
      <p className="usage-note">{zh ? "分组与个人计划需要各设备使用支持此功能的新版。计划按人、按额度日生效；自动建议不会覆盖共享手动设置。" : "Groups and plans require a compatible version on each device. Plans apply per person and quota day; automatic suggestions never publish over manual settings."}</p>
      {settings ? <>
        <div className="usage-sync-actions">
          <button type="button" disabled={working} onClick={() => void action(async () => { if (status?.imported) await saveUsageSyncSettings(settings); return syncUsageNow(); })}>{working ? (zh ? "同步中…" : "Syncing…") : (zh ? "立即同步" : "Sync now")}</button>
          <button type="button" disabled={working} onClick={() => void action(async () => {
            if (status?.imported) await saveUsageSyncSettings(settings);
            const current = await getPreferences(); const day = planDateKey(new Date());
            if (current.dailyBudgetLocalDate !== day) throw "shared_settings_plan_date_stale";
            await savePersonPlan(day, "dailyBudgetPercent", current.dailyBudgetPercent);
            await savePersonPlan(day, "resetRiskOverridePercent", current.resetRiskManualEnabled ? current.resetRiskOverridePercent : null);
            return syncUsageNow();
          })}>{zh ? "共享本机当前计划" : "Share this device's current plan"}</button>
          <label><input type="checkbox" checked={settings.enabled} disabled={working} onChange={e => void action(() => saveUsageSyncSettings({ ...settings, enabled: e.target.checked }))} />{zh ? "自动同步" : "Automatic sync"}</label>
          <select aria-label={zh ? "同步间隔" : "Sync interval"} value={settings.intervalSeconds} disabled={working} onChange={e => void action(() => saveUsageSyncSettings({ ...settings, intervalSeconds: Number(e.target.value) }))}>
            {[60, 300, 900, 1800].map(seconds => <option key={seconds} value={seconds}>{seconds / 60} {zh ? "分钟" : "min"}</option>)}
          </select>
        </div>
        <p className="usage-note">{status?.imported ? (zh ? "已发现现有配置，点击同步或开启自动同步后导入。" : "Existing settings found; sync or enable automatic sync to import.") : (zh ? "应用运行时自动同步；休眠或退出期间不采集。" : "Automatic while the app runs; no collection while sleeping or closed.")}</p>
        <details className="usage-sync-target"><summary>{zh ? "同步目标" : "Sync destination"}</summary><p>{settings.remote} · {settings.branch}</p><p>{zh ? "本机" : "This device"}: {settings.deviceId}</p></details>
      </> : status ? <form className="usage-sync-setup" onSubmit={e => { e.preventDefault(); void action(() => saveUsageSyncSettings(draft)); }}>
        <p className="usage-note">{zh ? "填写已有私有仓库的 SSH 地址，使用系统 Git / SSH 认证，不在这里保存密钥。" : "Use an existing private repository SSH address and system Git/SSH credentials."}</p>
        <input aria-label={zh ? "同步仓库" : "Sync repository"} placeholder="git@gitee.com:owner/usage.git" value={draft.remote} onChange={e => setDraft({ ...draft, remote: e.target.value })} required />
        <input aria-label={zh ? "设备标识" : "Device ID"} placeholder={zh ? "唯一设备标识" : "Unique device ID"} value={draft.deviceId} onChange={e => setDraft({ ...draft, deviceId: e.target.value })} required />
        <input aria-label={zh ? "同步分支" : "Sync branch"} value={draft.branch} onChange={e => setDraft({ ...draft, branch: e.target.value })} required />
        <button disabled={working}>{zh ? "保存同步设置" : "Save sync settings"}</button>
      </form> : <p className="usage-note">{zh ? "正在读取同步状态…" : "Reading sync status…"}</p>}
      {failure && <p className="usage-note" role="status">{errorText(failure, zh)}</p>}
      <div className="usage-sync-times"><span>{zh ? "最后成功" : "Last success"}: {timestamp(status?.lastSuccessAt, zh)}</span><span>{zh ? "最后尝试" : "Last attempt"}: {timestamp(status?.lastAttemptAt, zh)}</span></div>
      {status?.collectorStatus === "partial" && <p className="usage-note">{zh ? "本机记录仍有部分覆盖；保留已有历史，不重复累加。" : "Local coverage is partial; existing history is retained without double counting."}</p>}
      {status?.collectorStatus === "unavailable" && <p className="usage-note">{zh ? "本机采集暂不可用，当前保留历史快照。" : "Local collection is unavailable; historical snapshots are retained."}</p>}
      <ul className="usage-sync-devices">{devices.map(device => <li key={device.id}><span>{device.id === settings?.deviceId ? (zh ? "本机" : "This device") : device.id}</span><span>{timestamp(device.updatedAt, zh)} · {device.collectionPartial ? (zh ? "部分覆盖" : "Partial") : device.stale ? (zh ? "离线快照" : "Offline snapshot") : (zh ? "近期快照" : "Recent snapshot")}</span></li>)}</ul>
    </div>
  </details>;
}
