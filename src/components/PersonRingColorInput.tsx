import { useEffect, useState } from "react";

const COLORS = ["#9981eb", "#54aeb6", "#e6984e", "#648cca", "#d37898", "#89a54e"];

export function PersonRingColorInput({ name, value, zh, onChange }: { name: string; value: string; zh: boolean; onChange: (color: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = /^#[0-9a-f]{6}$/i.test(draft);
  return <div className="person-ring-color-input">
    <div className="person-ring-swatches">
      {COLORS.map(color => <button type="button" key={color} style={{ backgroundColor: color }} aria-label={`${name} ${color}`} aria-pressed={value.toLowerCase() === color} onClick={() => onChange(color)} />)}
    </div>
    <input type="text" maxLength={7} spellCheck={false} aria-label={`${name} ${zh ? "圆环颜色" : "ring color"}`} aria-invalid={!valid} value={draft} onChange={event => {
      const next = event.target.value;
      setDraft(next);
      if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next);
    }} onBlur={() => { if (!valid) setDraft(value); }} />
  </div>;
}
