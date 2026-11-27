import type { TokeiGroup } from "../lib/tokeiUsage";

export function UsageGroupSelect({ zh, groups, value, onChange }: {
  zh: boolean;
  groups: TokeiGroup[];
  value: string;
  onChange: (value: string) => void;
}) {
  return <select aria-label={zh ? "用量分组" : "Usage group"} value={value} onChange={event => onChange(event.target.value)}>
    <option value="" disabled>{zh ? "选择分组" : "Choose group"}</option>
    <option value="global">{zh ? "全局" : "Global"}</option>
    {groups.map(group => <option key={group.id} value={`group:${group.id}`}>{group.name}</option>)}
  </select>;
}
