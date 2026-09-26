import { useState } from "react";
import { validateGroupSettings, type TokeiGroupSettings } from "../lib/tokeiUsage";

interface Props {
  settings: TokeiGroupSettings;
  deviceIds: string[];
  zh: boolean;
  onSave: (settings: TokeiGroupSettings, expected: TokeiGroupSettings) => Promise<void>;
  onCancel?: () => void;
  title?: string;
  hint?: string;
  readOnly?: boolean;
  synced?: boolean;
  onReload?: () => Promise<void>;
}

export function UsageGroupEditor({ settings, deviceIds, zh, onSave, onCancel, title, hint, readOnly = false, synced = false, onReload }: Props) {
  const [draft, setDraft] = useState<TokeiGroupSettings>(() => ({ groups: structuredClone(settings.groups), defaultGroupId: settings.defaultGroupId }));
  const [expected] = useState<TokeiGroupSettings>(() => ({ groups: structuredClone(settings.groups), defaultGroupId: settings.defaultGroupId }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"conflict" | "failed" | null>(null);
  const devices = [...new Set([...deviceIds, ...settings.groups.flatMap((group) => group.deviceIds), ...draft.groups.flatMap((group) => group.deviceIds)])].sort();
  const valid = validateGroupSettings(draft);

  function assign(deviceId: string, groupId: string) {
    setDraft((current) => ({ ...current, groups: current.groups.map((group) => ({
      ...group, deviceIds: group.id === groupId
        ? [...group.deviceIds.filter((id) => id !== deviceId), deviceId]
        : group.deviceIds.filter((id) => id !== deviceId),
    })) }));
  }

  async function save() {
    if (!valid || busy || readOnly) return;
    setBusy(true); setError(null);
    try { await onSave(draft, expected); } catch (cause) { setError(String(cause).includes("conflict") ? "conflict" : "failed"); } finally { setBusy(false); }
  }

  const heading = title ?? (zh ? "组员与设备" : "Members & devices");
  const description = hint ?? (zh ? "设备归属决定用量算给谁" : "Device assignment decides whose usage is counted");

  return <section className="usage-group-editor" aria-label={heading}>
    <header className="usage-editor-heading"><strong>{heading}</strong><span>{description}</span></header>
    {readOnly && <p className="usage-note">{zh ? "当前无法编辑，请稍后重试。" : "Editing is unavailable right now. Try again later."}</p>}
    <fieldset disabled={busy || readOnly}>
      <div className="usage-editor-subheading">{zh ? "组员" : "Members"}</div>
      {draft.groups.map((group, index) => <div key={group.id} className="usage-group-name">
        <input aria-label={`${zh ? "组员名称" : "Member name"} ${index + 1}`} maxLength={64} value={group.name} onChange={(event) => setDraft((current) => ({ ...current, groups: current.groups.map((item) => item.id === group.id ? { ...item, name: event.target.value } : item) }))} />
        <button type="button" aria-label={`${zh ? "删除组员" : "Remove member"} ${group.name || index + 1}`} onClick={() => setDraft((current) => ({ groups: current.groups.filter((item) => item.id !== group.id), defaultGroupId: current.defaultGroupId === group.id ? null : current.defaultGroupId }))}>{zh ? "删除" : "Remove"}</button>
      </div>)}
      <button type="button" className="usage-text-button" disabled={draft.groups.length >= 32} onClick={() => {
        const id = `group-${crypto.randomUUID()}`;
        setDraft((current) => ({ groups: [...current.groups, { id, name: "", deviceIds: [] }], defaultGroupId: current.defaultGroupId ?? id }));
      }}>{zh ? "+ 新增组员" : "+ Add member"}</button>
      <label className="usage-setting-row usage-default-member"><span>{zh ? "默认打开的组员" : "Default member to show"}<small>{zh ? "所有设备通用；不改变下方设备归属" : "Shared by all devices; does not change assignments"}</small></span>
        <select aria-label={zh ? "默认打开的组员" : "Default member to show"} value={draft.defaultGroupId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, defaultGroupId: event.target.value || null }))}>
          <option value="">{zh ? "不预选" : "No preselection"}</option>
          {draft.groups.map((group, index) => <option key={group.id} value={group.id}>{group.name || `${zh ? "新组员" : "New member"} ${index + 1}`}</option>)}
        </select>
      </label>
      <div className="usage-device-settings">
        <div className="usage-editor-subheading">{zh ? "设备用量算给谁" : "Whose usage each device counts toward"}</div>
        {devices.map((id) => <label key={id} className="usage-setting-row"><span title={id}>{id}</span>
          <select aria-label={`${zh ? "设备归属" : "Device group"}: ${id}`} value={draft.groups.find((group) => group.deviceIds.includes(id))?.id ?? ""} onChange={(event) => assign(id, event.target.value)}>
            <option value="">{zh ? "未分组" : "Unassigned"}</option>
            {draft.groups.map((group, index) => <option key={group.id} value={group.id}>{group.name || `${zh ? "新组员" : "New member"} ${index + 1}`}</option>)}
          </select>
        </label>)}
      </div>
    </fieldset>
    {!valid && <p className="usage-note">{zh ? "请填写不重复的组员名称，并将每台设备只分配给一名组员。" : "Use unique member names and assign each device to one member."}</p>}
    {error && <div className="usage-editor-error"><p className="usage-error" role="alert">{error === "conflict" ? (zh ? "另一台设备刚修改了分配。请重新读取后再保存，避免覆盖对方的设置。" : "Another device changed assignments. Reload before saving so its edits are not overwritten.") : (zh ? "未保存成功，请检查连接后重试。原设置不会被覆盖。" : "Not saved. Check the connection and retry; existing settings remain intact.")}</p>{error === "conflict" && onReload && <button type="button" onClick={() => void onReload().catch(() => setError("failed"))}>{zh ? "重新读取" : "Reload"}</button>}</div>}
    {!readOnly && <footer className="usage-editor-actions">{onCancel ? <button type="button" disabled={busy} onClick={onCancel}>{zh ? "取消" : "Cancel"}</button> : null}<button type="button" disabled={!valid || busy} onClick={() => void save()}>{busy ? (zh ? "保存中…" : "Saving…") : synced ? (zh ? "保存并同步" : "Save and sync") : (zh ? "保存组员" : "Save members")}</button></footer>}
  </section>;
}
