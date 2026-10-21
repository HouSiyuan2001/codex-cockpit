import { useEffect, useState } from "react";
import { isTauri } from "../lib/bridge";
import { chooseCodexDirectory, getLocalUsageSource, saveLocalUsageSource, sourceErrorText, type LocalUsageSource } from "../lib/localUsageBridge";

export function LocalUsageSourceSettings({ zh, compact = false, noRecords = false, onSaved }: { zh: boolean; compact?: boolean; noRecords?: boolean; onSaved?: () => void }) {
  const [source, setSource] = useState<LocalUsageSource | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    getLocalUsageSource().then(next => { if (active) setSource(next); }).catch(() => { if (active) setError(zh ? "无法读取本机设置。" : "Local settings unavailable."); });
    return () => { active = false; };
  }, [zh]);
  async function choose() {
    setBusy(true); setError(null);
    try { setChosen(await chooseCodexDirectory()); }
    catch { setError(zh ? "无法打开目录选择窗口，请检查系统权限。" : "Cannot open the folder picker. Check system permissions."); }
    finally { setBusy(false); }
  }
  async function save(directory: string | null) {
    setBusy(true); setError(null);
    try { setSource(await saveLocalUsageSource(directory)); setChosen(null); onSaved?.(); }
    catch (error) { setError(sourceErrorText(error, zh)); }
    finally { setBusy(false); }
  }
  const hint = source?.state === "missing"
    ? (zh ? "没有找到 Codex 数据目录，这不是用量为 0。你可以手动选择目录。" : "Codex data folder not found. This does not mean zero usage. You can select it below.")
    : source && ["unreadable", "unsafe", "invalid"].includes(source.state)
      ? (zh ? "无法读取 Codex 数据目录，这不是用量为 0。请检查权限或重新选择。" : "The Codex folder is unreadable, not zero usage. Check permissions or choose another folder.")
      : noRecords ? (zh ? "目录可读取，但还没有可统计的用量记录。请先在 Codex 中运行一个任务，再刷新。" : "The folder is readable, but has no usage records yet. Run a Codex task, then refresh.")
        : null;
  return <section className={`local-usage-source${compact ? " local-usage-source--compact" : ""}`} aria-label={zh ? "本机 Codex 数据" : "Local Codex data"}>
    <h3>{zh ? "本机数据" : "Local data"}</h3>
    {(!source || hint) && <p role="status">{source ? hint : zh ? "正在检查数据目录…" : "Checking the data folder…"}</p>}
    {source && <p className="local-usage-path"><code>{source.directory}</code></p>}
    <p>{zh ? "只读统计，不上传聊天正文。" : "Read-only usage collection. No chat uploads."}</p>
    {chosen ? <div className="local-usage-consent">
      <p>{zh ? "确认允许驾驶舱读取这个 Codex 目录？" : "Allow Cockpit to read this Codex folder?"}</p><code>{chosen}</code>
      <div className="local-usage-actions"><button type="button" disabled={busy} onClick={() => { void save(chosen); }}>{zh ? "允许读取并开始统计" : "Allow read and start collection"}</button><button type="button" disabled={busy} onClick={() => setChosen(null)}>{zh ? "取消" : "Cancel"}</button></div>
    </div> : <div className="local-usage-actions">
      <button type="button" disabled={busy || !isTauri()} onClick={() => { void choose(); }}>{zh ? "更改目录" : "Change folder"}</button>
    </div>}
    <details>
      <summary>{zh ? "读取详情" : "Collection details"}</summary>
      {source && <p>{source.selection === "manual" ? (zh ? "已手动选择目录" : "Manually selected folder") : (zh ? "自动查找目录" : "Automatic folder discovery")}</p>}
      <p>{zh ? "仅读取用量和任务信息，不修改 Codex 文件。选择目录不会开启云同步。" : "Reads usage and task metadata without changing Codex files. Choosing a folder does not enable cloud sync."}</p>
      {source?.selection === "manual" && <button type="button" disabled={busy} onClick={() => { void save(null); }}>{zh ? "恢复自动查找" : "Use automatic discovery"}</button>}
    </details>
    {source?.state === "preview" && <p>{zh ? "浏览器仅预览界面，请在已安装的 App 中选择目录。" : "Browser preview only. Choose a folder in the installed app."}</p>}
    {error && <p className="usage-error" role="alert">{error}</p>}
  </section>;
}
