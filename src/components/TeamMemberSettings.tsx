import { useEffect, useState } from "react";
import { groupColors } from "../lib/dailyPersonCosts";
import { getTokeiUsage, saveTokeiGroups } from "../lib/tokeiBridge";
import type { TokeiGroupSettings, TokeiUsage } from "../lib/tokeiUsage";
import type { WidgetPreferences } from "../types";
import { PersonRingColorInput } from "./PersonRingColorInput";
import { UsageGroupEditor } from "./UsageGroupEditor";
import { isTauri } from "../lib/bridge";

interface Props {
  usage: TokeiUsage | null;
  loadingError: boolean;
  preferences: WidgetPreferences;
  zh: boolean;
  onPreferences: (value: WidgetPreferences) => void;
  onSaved?: () => Promise<unknown> | void;
}

function settingsFrom(usage: TokeiUsage): TokeiGroupSettings {
  return { groups: structuredClone(usage.groups), defaultGroupId: usage.defaultGroupId };
}

export function TeamMemberSettings({ usage, loadingError, preferences, zh, onPreferences, onSaved = () => undefined }: Props) {
  const [settings, setSettings] = useState<TokeiGroupSettings | null>(() => usage ? settingsFrom(usage) : null);
  const [cloudConnected, setCloudConnected] = useState(false);
  const [cloudDevices, setCloudDevices] = useState<string[]>([]);
  const [editorVersion, setEditorVersion] = useState(0);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke<{ config: { role: string } | null; members: { deviceId: string }[] }>("get_cloud_sync_status")).then(status => {
      if (active) { setCloudConnected(Boolean(status.config)); setCloudDevices(status.members.map(member => member.deviceId)); }
    }).catch(() => {});
    return () => { active = false; };
  }, [usage]);

  useEffect(() => {
    if (usage) setSettings(settingsFrom(usage));
  }, [usage]);

  async function save(next: TokeiGroupSettings, expected: TokeiGroupSettings) {
    const saved = await saveTokeiGroups(next, expected);
    setSettings(saved);
    setEditorVersion(value => value + 1);
    try { await onSaved(); } catch { /* The member save succeeded; a refresh can retry later. */ }
  }
  async function reload() {
    const latest = await getTokeiUsage();
    setSettings(settingsFrom(latest));
    setEditorVersion(value => value + 1);
    await onSaved();
  }

  const ringColors = groupColors(settings?.groups.map(group => group.id) ?? []);
  const updatePreferences = (patch: Partial<WidgetPreferences>) => onPreferences({ ...preferences, ...patch });

  return <>
    {settings && usage ? <UsageGroupEditor key={editorVersion} settings={settings} deviceIds={[...usage.devices.map(device => device.id), ...cloudDevices]} zh={zh} onSave={save} onReload={reload} synced={cloudConnected} /> : <section className="minimal-section team-member-placeholder" aria-label={zh ? "组员与设备" : "Members & devices"}>
      <header className="minimal-section-header"><strong>{zh ? "组员与设备" : "Members & devices"}</strong></header>
      <p className={loadingError ? "usage-error" : "usage-note"} role="status">{loadingError ? (zh ? "暂时无法读取组员，请稍后重试。" : "Members are unavailable. Try again shortly.") : (zh ? "正在读取组员…" : "Loading members…")}</p>
    </section>}

    <section className="minimal-section" aria-labelledby="person-ring-colors-title">
      <header className="minimal-section-header"><strong id="person-ring-colors-title">{zh ? "组员圆环颜色" : "Member ring colors"}</strong><small>{zh ? "用于用量圆环" : "Used in usage rings"}</small></header>
      {(settings?.groups ?? []).map(person => (
        <div key={person.id} className="person-ring-color-row">
          <span>{person.name}</span><PersonRingColorInput name={person.name} zh={zh} value={preferences.personRingColors?.[person.id] ?? ringColors.get(person.id)!} onChange={color => updatePreferences({ personRingColors: { ...preferences.personRingColors, [person.id]: color } })} />
          <button type="button" aria-label={`${person.name} ${zh ? "恢复默认颜色" : "reset ring color"}`} disabled={!preferences.personRingColors?.[person.id]} onClick={() => {
            const colors = { ...preferences.personRingColors };
            delete colors[person.id];
            updatePreferences({ personRingColors: colors });
          }}>{zh ? "默认" : "Reset"}</button>
        </div>
      ))}
      {!settings?.groups.length ? <small>{zh ? "暂无组员，可在上方新增" : "No members yet; add one above"}</small> : null}
    </section>
  </>;
}
