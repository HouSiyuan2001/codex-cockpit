import { useEffect, useState } from "react";
import { isTauri } from "../lib/bridge";
import { getUsageSyncStatus, syncUsageNow, type UsageSyncStatus } from "../lib/usageSyncBridge";
import type { TokeiUsage } from "../lib/tokeiUsage";

interface CloudStatus {
  lastPulledAt?: string | null;
  sharedRevision?: number;
  pricingReady?: boolean;
  config: { endpoint: string; shareTaskDetails: boolean; deviceId: string; spaceId: string; spaceName: string; role: string; enabled: boolean; intervalSeconds: number } | null;
  members: { deviceId: string; displayName: string; role: string; updatedAt: number | null; syncInfo?: { protocolVersion: number; appVersion: string; settingsRevision: number } | null; costCoverage?: {knownModels: number; totalModels: number} }[];
}
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return { config: null, members: [] } as T;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}
const when = (time: string | number | null | undefined, zh: boolean) => time ? new Date(typeof time === "number" ? time * 1000 : time).toLocaleString(zh ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : (zh ? "尚无记录" : "No record");

export function CloudSyncSettings({ usage, zh, onSynced }: { usage: TokeiUsage | null; zh: boolean; onSynced: () => Promise<unknown> | void }) {
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [runtime, setRuntime] = useState<UsageSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [device, setDevice] = useState("");
  const [invite, setInvite] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [mode, setMode] = useState<"join" | "create">("join");
  const [spaceName, setSpaceName] = useState("");
  const [secret, setSecret] = useState("");
  const [shareTasks, setShareTasks] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [next, status] = await Promise.all([call<CloudStatus>("get_cloud_sync_status"), getUsageSyncStatus()]);
        if (active) { setCloud(next); setRuntime(status); setDevice(current => current || status.settings?.deviceId || `device-${crypto.randomUUID().slice(0, 8)}`); }
      } catch { if (active) setError(zh ? "暂时无法读取云同步状态" : "Cloud status unavailable"); }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [zh]);
  async function action(run: () => Promise<unknown>) {
    setBusy(true); setError("");
    try {
      await run();
      setCloud(await call<CloudStatus>("get_cloud_sync_status"));
      setRuntime(await getUsageSyncStatus());
      await onSynced();
    } catch (e) {
      const code = String(e);
      setError(/rate_limited/.test(code) ? (zh ? "请求过于频繁，请至少等待一分钟再试，不要连续点击。" : "Too many requests. Wait at least a minute before retrying.") : /service_unavailable/.test(code) ? (zh ? "服务暂不可用，请管理员检查限流绑定和服务器状态。" : "Service unavailable. Ask the operator to check rate-limit bindings and server status.") : /endpoint_invalid/.test(code) ? (zh ? "服务地址须为 HTTPS 域名，不带路径或参数。" : "Use an HTTPS origin without a path or query.") : /identity_mismatch|identity_locked/.test(code) ? (zh ? "设备身份与本机原有记录不一致，请沿用本机设备标识。" : "Keep this computer's existing device ID.") : /invite_required/.test(code) ? (zh ? "请输入邀请码加入共享空间。" : "Enter an invitation to join.") : /denied|conflict/.test(code) ? (zh ? "请检查权限、邀请码或建站密钥，以及设备标识是否已被使用。" : "Check permissions, the invitation or setup secret and whether the device ID is already used.") : (zh ? "云同步未完成，请检查网络或系统凭据存储后重试。" : "Cloud sync failed. Check networking or the system credential store and retry."));
    } finally { setBusy(false); }
  }
  const connected = cloud?.config;
  const failure = connected && runtime?.lastError;
  return <section className="minimal-section cloud-sync-settings" aria-label={zh ? "云同步" : "Cloud sync"}>
    <header className="minimal-section-header"><strong>{zh ? "云同步" : "Cloud sync"}</strong><small>Cloudflare</small></header>
    {connected ? <>
      <p>{connected.spaceName} · {runtime?.phase === "running" ? (zh ? "同步中" : "Syncing") : failure ? (zh ? "同步失败，可重试" : "Sync failed; retry") : (zh ? "已连接" : "Connected")}</p>
      <p className="usage-note cloud-endpoint">{connected.endpoint}</p>
      <div className="usage-sync-actions">
        <button disabled={busy || runtime?.phase === "running"} onClick={() => void action(async () => { const result = await syncUsageNow(); if (result.lastError) throw result.lastError; })}>{zh ? "立即同步" : "Sync now"}</button>
        <label><input type="checkbox" checked={connected.enabled} disabled={busy} onChange={event => void action(() => call("set_cloud_sync_enabled", { enabled: event.target.checked }))} />{zh ? "自动同步 · 每分钟接收 / 每5分钟上传" : "Automatic · download every minute / upload every 5 min"}</label>
        <label><input type="checkbox" checked={connected.shareTaskDetails ?? false} disabled={busy} onChange={event => void action(() => call("set_cloud_task_sharing", { enabled: event.target.checked }))} />{zh ? "共享任务名称和项目名称" : "Share task and project names"}</label>
        {connected.role === "owner" && <button disabled={busy} onClick={() => void action(async () => { const result = await call<{ inviteCode: string }>("create_cloud_invite"); setInvite(result.inviteCode); })}>{zh ? "邀请组员 / 新设备" : "Invite member / device"}</button>}
      </div>
      {invite && <label className="cloud-invite">{zh ? "邀请码（24小时有效，仅可使用一次）" : "Invitation (24 hours, single use)"}<input readOnly value={invite} aria-label={zh ? "新邀请码" : "New invitation"} /></label>}
      {connected.role === "owner" && <details>
        <summary>{zh ? "设备访问权限" : "Device access"}</summary>
        <p className="usage-note">{zh ? "停用会立即阻止该设备后续访问；不会删除历史快照、其他设备的缓存或备份。恢复接入由管理员处理，不要复制身份令牌。" : "Revocation blocks future access, but does not erase snapshots, peer caches or backups. Contact the operator to restore access; never copy credentials."}</p>
        {cloud?.members.filter(member => member.role !== "owner" && member.deviceId !== connected.deviceId).map(member => <div key={member.deviceId}>
          <span>{member.displayName} · {member.deviceId}</span>
          <button type="button" disabled={busy} onClick={() => setRevokeTarget(member.deviceId)}>{zh ? "停用设备" : "Revoke device"}</button>
        </div>)}
        {revokeTarget && <div role="alert">
          <p>{zh ? "确认停用这台设备？" : "Revoke access for this device?"} {revokeTarget}</p>
          <button type="button" disabled={busy} onClick={() => void action(async () => { await call("revoke_cloud_device", { deviceId: revokeTarget }); setRevokeTarget(null); })}>{zh ? "确认停用" : "Confirm revocation"}</button>
          <button type="button" disabled={busy} onClick={() => setRevokeTarget(null)}>{zh ? "取消" : "Cancel"}</button>
        </div>}
      </details>}
      <p className="usage-note">{zh ? "最近同步" : "Last synced"}: {when(runtime?.lastSuccessAt, zh)}</p>
      {/collector_(timeout|busy)/.test(runtime?.lastError ?? "") && <p role="status" className="usage-note">{zh ? "本机用量采集繁忙或超时，稍后自动重试；云端已接收的数据仍保留。" : "Local collection is busy or timed out and will retry; downloaded cloud data is retained."}</p>}
    </> : <>
      <p className="usage-note">{zh ? "使用你信任的自建服务。加入后，这台电脑的用量会同步给其他设备；不会上传对话正文或模型账号密钥。" : "Use a server you trust. Joined devices share usage, not conversation bodies or provider credentials."}</p>
      <div className="usage-sync-actions">
        <button type="button" aria-pressed={mode === "join"} onClick={() => setMode("join")}>{zh ? "接受邀请" : "Join a space"}</button>
        <button type="button" aria-pressed={mode === "create"} onClick={() => setMode("create")}>{zh ? "创建共享空间" : "Create a space"}</button>
      </div>
      <form className="cloud-setup-form" onSubmit={event => { event.preventDefault(); void action(async () => {
        await call("connect_cloud_sync", { setup: { endpoint: endpoint.trim(), inviteCode: mode === "join" ? code.trim() : null, displayName: name.trim(), deviceId: device.trim(), spaceName: mode === "create" ? spaceName.trim() : null, bootstrapSecret: mode === "create" ? secret : null, shareTaskDetails: shareTasks } });
        setSecret(""); setCode("");
        // Enrollment succeeds independently of a slow first collection.
        setCloud(await call<CloudStatus>("get_cloud_sync_status"));
        const result = await syncUsageNow(); if (result.lastError) throw result.lastError;
      }); }}>
        <label>{zh ? "服务地址" : "Server URL"}<input required type="url" placeholder="https://your-worker.workers.dev" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label>
        {mode === "join" ? <label>{zh ? "邀请码" : "Invitation"}<input required autoComplete="off" value={code} onChange={event => setCode(event.target.value)} /></label> : <>
          <label>{zh ? "空间名称" : "Space name"}<input required maxLength={64} value={spaceName} onChange={event => setSpaceName(event.target.value)} /></label>
          <label>{zh ? "建站密钥" : "Setup secret"}<input required type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} /></label>
          <small>{zh ? "部署 Cloudflare 时设置的 BOOTSTRAP_SECRET，仅用于创建空间。" : "The BOOTSTRAP_SECRET set during deployment; used only to create a space."}</small>
        </>}
        <label>{zh ? "显示名称" : "Display name"}<input required maxLength={64} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>{zh ? "本机设备标识" : "Device ID"}<input required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]*" maxLength={128} value={device} onChange={event => setDevice(event.target.value)} /></label>
        <small>{zh ? "每台设备使用不同标识；重新连接时沿用原标识。" : "Use a unique ID per device; keep it when reconnecting."}</small>
        <label className="cloud-share-option"><input type="checkbox" checked={shareTasks} onChange={event => setShareTasks(event.target.checked)} />{zh ? "共享任务名称和项目名称（可选）" : "Share task and project names (optional)"}</label>
        <button disabled={busy}>{busy ? (zh ? "连接中…" : "Connecting…") : (zh ? "连接并同步" : "Connect and sync")}</button>
      </form>
    </>}
    {error && <p role="alert" className="usage-error">{error}</p>}
    {connected && <p className="usage-note">{zh ? "已加入的设备都可修改组员与设备归属；保存后同步到其他设备。" : "Any joined device can edit member and device assignments; changes sync after saving."}</p>}
    <details className="cloud-sync-details"><summary>{zh ? "设备同步详情" : "Device sync details"}</summary>
    {connected && <p className="usage-note">{zh ? "最近接收云端数据" : "Last cloud download"}: {when(cloud?.lastPulledAt, zh)} · {cloud?.pricingReady ? (zh ? `计价配置已就绪` : `Pricing ready`) : (zh ? "计价配置未就绪" : "Pricing unavailable")}</p>}
    <div className="cloud-member-status">{usage?.groups.map(group => <div key={group.id}>
      <strong>{group.name}</strong>
      {!group.deviceIds.length && <p className="usage-note">{zh ? "尚未分配设备" : "No devices assigned"}</p>}
      {group.deviceIds.map(id => {
        const member = cloud?.members.find(member => member.deviceId === id);
        const old = usage.devices.find(device => device.id === id);
        const recent = member?.updatedAt && Date.now() / 1000 - member.updatedAt < 900;
        return <div className="cloud-device-status" key={id}><span title={id}>{id}</span><small>{member ? recent ? (zh ? "近期已同步" : "Recently synced") : (zh ? "等待设备同步" : "Awaiting device") : (zh ? "尚未接入云同步" : "Not on cloud yet")} · {when(member ? member.updatedAt : old?.updatedAt, zh)}</small>{member && <small>{!member.syncInfo ? (zh ? "旧版协议 · 需升级以接收统一价格表" : "Legacy protocol · upgrade for shared pricing") : member.syncInfo.settingsRevision !== cloud?.sharedRevision ? (zh ? "共享配置待更新" : "Shared settings pending") : (zh ? "共享配置一致" : "Shared settings match")}{member.costCoverage && member.costCoverage.totalModels > 0 ? (zh ? ` · 今日可估算模型 ${member.costCoverage.knownModels}/${member.costCoverage.totalModels}` : ` · Today's priced models ${member.costCoverage.knownModels}/${member.costCoverage.totalModels}`) : ""}</small>}</div>;
      })}
    </div>)}{cloud?.members.filter(member => !usage?.groups.some(group => group.deviceIds.includes(member.deviceId))).map(member => <div className="cloud-device-status" key={member.deviceId}><strong>{member.displayName} · {zh ? "待分配组员" : "Needs assignment"}</strong><span>{member.deviceId}</span><small>{when(member.updatedAt, zh)}</small></div>)}</div>
    </details>
  </section>;
}
