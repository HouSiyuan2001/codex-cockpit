import { useId, useState } from "react";
import { aggregateTaskUsage, type ProjectUsageSnapshot, type UsagePeriod } from "../lib/tokeiUsage";

type Props = {
  source: ProjectUsageSnapshot;
  scopedSource: ProjectUsageSnapshot;
  deviceIds: string[];
  period: UsagePeriod;
  zh: boolean;
  onShowHistory: () => void;
  onShowAllMembers: () => void;
};

/** A missing task payload is not an empty ledger or proof the sender opted out. */
export function PeerTaskStatus({ source, scopedSource, deviceIds, period, zh, onShowHistory, onShowAllMembers }: Props) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const peers = [...new Map((source.peerTasks ?? []).map(peer => [peer.deviceId, peer])).values()]
    .filter(peer => peer.deviceId !== source.deviceId);
  const selected = peers.filter(peer => deviceIds.includes(peer.deviceId));
  const outside = peers.length - selected.length;
  const states = selected.map(peer => {
    const status = peer.taskDetailsStatus ?? "available";
    const settings = { groups: [{ id: "peer", name: "peer", deviceIds: [peer.deviceId] }], defaultGroupId: "peer" };
    const current = scopedSource.peerTasks?.find(row => row.deviceId === peer.deviceId);
    const currentCount = status === "available" ? aggregateTaskUsage({ ...scopedSource, deviceId: peer.deviceId, tasks: current?.tasks ?? [] }, settings, "peer", period).rows.length : 0;
    const historyCount = status === "available" ? aggregateTaskUsage({ ...source, deviceId: peer.deviceId, tasks: peer.tasks }, settings, "peer", "all").rows.length : 0;
    return { ...peer, status, currentCount, historyCount };
  });
  if (!states.length && !outside) return null;
  const missing = states.filter(peer => peer.status !== "available").length;
  const filtered = states.filter(peer => peer.historyCount > 0 && peer.currentCount === 0).length;
  return <section className="usage-peer-status" aria-label={zh ? "跨设备任务状态" : "Peer task status"}>
    <div className="usage-peer-heading">
      <span>{zh ? "跨设备任务提示" : "Peer task tips"}</span>
      <button type="button" className="usage-peer-toggle" aria-expanded={expanded} aria-controls={detailsId}
        aria-label={zh ? `${expanded ? "收起" : "展开"}跨设备任务提示` : `${expanded ? "Hide" : "Show"} peer task tips`}
        onClick={() => setExpanded(value => !value)}>{expanded ? (zh ? "收起" : "Hide") : (zh ? "展开" : "Show")}</button>
    </div>
    <div id={detailsId} hidden={!expanded} className="usage-peer-details">
    <p role="status">{zh
      ? `跨设备任务：${states.length - missing} 台已提供明细${missing ? ` · ${missing} 台明细未就绪` : ""}${filtered ? ` · ${filtered} 台仅有其他日期记录` : ""}`
      : `Peer tasks: ${states.length - missing} devices provided details${missing ? ` · ${missing} awaiting details` : ""}${filtered ? ` · ${filtered} only have records outside this period` : ""}`}</p>
    <div className="usage-peer-actions">
      {filtered > 0 && <button type="button" className="usage-text-button" onClick={onShowHistory}>{zh ? "查看历史任务" : "Show historical tasks"}</button>}
      {outside > 0 && <button type="button" className="usage-text-button" onClick={onShowAllMembers}>{zh ? `查看全部组员任务（另 ${outside} 台设备）` : `Show all members' tasks (${outside} other devices)`}</button>}
    </div>
      <ul>{states.map(peer => <li key={peer.deviceId}>
        <strong>{peer.deviceId}</strong>{" · "}{peer.status === "not-provided"
          ? (zh ? "对方快照未提供任务明细。" : "The peer snapshot has no task details.")
          : peer.status === "not-received"
            ? (zh ? "尚未收到可读取的任务快照。" : "No readable task snapshot received yet.")
            : peer.historyCount > 0 && peer.currentCount === 0
              ? (zh ? "历史任务已同步，当前日期范围未包含。" : "Historical tasks are synced, outside the selected dates.")
              : (zh ? `当前范围 ${peer.currentCount} 项${peer.partial ? " · 明细部分覆盖" : ""}` : `${peer.currentCount} in this period${peer.partial ? " · Partial details" : ""}`)}
        {peer.updatedAt && Number.isFinite(Date.parse(peer.updatedAt)) && <small>{zh ? "快照时间：" : "Snapshot: "}{new Date(peer.updatedAt).toLocaleString(zh ? "zh-CN" : "en-US")}</small>}
      </li>)}</ul>
    {states.some(peer => peer.status === "not-provided") && <p>{zh ? "请在来源设备检查“共享任务与项目名”并同步；不能据此认为没有用量。" : "Check task sharing and sync on the source device; this does not mean zero usage."}</p>}
    </div>
  </section>;
}
