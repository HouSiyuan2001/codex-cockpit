import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { formatTokens, type AggregatedTaskUsage } from "../lib/tokeiUsage";
import { copyCustomTaskCard, prepareCustomTaskCardFont } from "../lib/customTaskCard";
import "./CustomTaskStatistics.css";

const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tearDistance = 70;
type TearPosition = { x: number; y: number };
type TearGesture = { pointerId: number; startX: number; startY: number; position: TearPosition };

/** Rows are already range-filtered and include descendants exactly once. Selection never alters the shared ledger. */
export function CustomTaskStatistics({ rows, zh, loading = false, error = false, partial = false, periodLabel }: {
  rows: AggregatedTaskUsage[]; zh: boolean; loading?: boolean; error?: boolean; partial?: boolean; periodLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [printPhase, setPrintPhase] = useState<"idle" | "preparing" | "printing" | "ready" | "tearing" | "success" | "error">("idle");
  const [copyError, setCopyError] = useState("");
  const [tearPosition, setTearPosition] = useState<TearPosition>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const printGeneration = useRef(0);
  const tearGesture = useRef<TearGesture | null>(null);
  const tearTimer = useRef<number | null>(null);
  const id = useId();
  useEffect(() => {
    const available = new Set(rows.map(row => row.id));
    setSelected(current => [...current].every(key => available.has(key)) ? current : new Set([...current].filter(key => available.has(key))));
  }, [rows]);
  useEffect(() => {
    printGeneration.current += 1;
    if (tearTimer.current !== null) window.clearTimeout(tearTimer.current);
    tearGesture.current = null;
    setTearPosition({ x: 0, y: 0 });
    setDragging(false);
    setPrintPhase("idle");
    setCopyError("");
  }, [selected, periodLabel]);
  useEffect(() => () => { if (tearTimer.current !== null) window.clearTimeout(tearTimer.current); }, []);
  useEffect(() => {
    if (printPhase !== "printing") return;
    const timer = window.setTimeout(() => setPrintPhase("ready"), 1250);
    return () => window.clearTimeout(timer);
  }, [printPhase]);
  const sorted = useMemo(() => [...rows].sort((a, b) => ((b.estimatedCostUsd ?? b.knownCostUsd) ?? -1) - ((a.estimatedCostUsd ?? a.knownCostUsd) ?? -1) || a.name.localeCompare(b.name)), [rows]);
  const chosen = rows.filter(row => selected.has(row.id));
  const known = chosen.flatMap(row => { const value = row.estimatedCostUsd ?? row.knownCostUsd; return value == null ? [] : [value]; });
  const unknown = chosen.filter(row => row.estimatedCostUsd == null || row.costIncomplete).length;
  const total = known.reduce((sum, value) => sum + value, 0);
  const toggle = (key: string) => setSelected(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const copyTornReceipt = async () => {
    const generation = printGeneration.current;
    const started = performance.now();
    setPrintPhase("tearing");
    setCopyError("");
    try {
      // Start clipboard.write in this pointer/keyboard gesture, before yielding user activation.
      await copyCustomTaskCard(chosen, periodLabel, zh);
      if (generation !== printGeneration.current) return;
      tearTimer.current = window.setTimeout(() => {
        if (generation === printGeneration.current) setPrintPhase("success");
        tearTimer.current = null;
      }, Math.max(0, 420 - (performance.now() - started)));
    } catch (reason) {
      if (generation !== printGeneration.current) return;
      setTearPosition({ x: 0, y: 0 });
      setPrintPhase("error");
      setCopyError(reason instanceof Error ? reason.message : (zh ? "复制失败" : "Copy failed"));
    }
  };
  const printOrCopy = async () => {
    if (printPhase === "preparing" || printPhase === "printing" || printPhase === "tearing") return;
    if (printPhase !== "ready") {
      const generation = printGeneration.current;
      setPrintPhase("preparing");
      setCopyError("");
      try {
        await prepareCustomTaskCardFont();
        if (generation === printGeneration.current) setPrintPhase("printing");
      } catch (reason) {
        if (generation === printGeneration.current) {
          setPrintPhase("error");
          setCopyError(reason instanceof Error ? reason.message : (zh ? "字体加载失败" : "Font loading failed"));
        }
      }
      return;
    }
    void copyTornReceipt();
  };
  const updateTearPosition = (event: PointerEvent<HTMLDivElement>, gesture: TearGesture) => {
    const position = {
      x: Math.max(-35, Math.min(150, event.clientX - gesture.startX)),
      y: Math.max(-35, Math.min(135, event.clientY - gesture.startY)),
    };
    gesture.position = position;
    setTearPosition(position);
    return position;
  };
  const stopTear = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = tearGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const position = cancelled ? gesture.position : updateTearPosition(event, gesture);
    tearGesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && Math.hypot(Math.max(0, position.x), Math.max(0, position.y)) >= tearDistance) {
      void copyTornReceipt();
    } else {
      setTearPosition({ x: 0, y: 0 });
    }
  };
  const paperStyle = { "--tear-x": `${tearPosition.x}px`, "--tear-y": `${tearPosition.y}px`, "--tear-angle": `${Math.max(-10, Math.min(12, (tearPosition.x - tearPosition.y) / 12))}deg` } as CSSProperties;
  return <section className="custom-task-statistics">
    <button type="button" className="usage-text-button custom-statistics-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{zh ? "自定义统计" : "Custom statistics"}{open ? " ▴" : " ▾"}</button>
    {open && <div id={id} className="custom-statistics-panel" role="region" aria-label={zh ? "自定义任务统计" : "Custom task statistics"}>
      <header><strong title={zh ? "任务含子 Agent，合计只计一次" : "Includes subagents, counted once"}>{periodLabel}</strong></header>
      <div className="custom-statistics-total" role="status" aria-live="polite">
        <span>{zh ? `已选 ${chosen.length} 项` : `${chosen.length} selected`}</span>
        <strong>{chosen.length && !known.length ? (zh ? "暂无估算" : "Estimate unavailable") : money(total)}</strong>
        <small>{unknown ? (zh ? `仅已知金额 · ${unknown} 项成本不全` : `Known amount only · ${unknown} incomplete`) : (zh ? "成本合计" : "Total cost")} · {formatTokens(chosen.reduce((sum, row) => sum + row.totalTokens, 0), zh)} Tokens</small>
      </div>
      <div className="custom-statistics-actions"><button type="button" onClick={() => setSelected(new Set(rows.map(row => row.id)))} disabled={!rows.length}>{zh ? "全选" : "Select all"}</button><button type="button" onClick={() => setSelected(new Set())} disabled={!chosen.length}>{zh ? "清空选择" : "Clear selection"}</button><button type="button" className="custom-statistics-copy" onClick={() => void printOrCopy()} disabled={!chosen.length || printPhase === "preparing" || printPhase === "printing" || printPhase === "tearing"}>{printPhase === "ready" ? (zh ? "直接复制 PNG" : "Copy PNG") : printPhase === "preparing" || printPhase === "printing" ? (zh ? "打印中…" : "Printing…") : printPhase === "tearing" ? (zh ? "复制中…" : "Copying…") : (zh ? "打印账单 PNG" : "Print receipt PNG")}</button></div>
      {printPhase !== "idle" && <div className={`receipt-printer receipt-printer--${printPhase}${dragging ? " receipt-printer--dragging" : ""}`} role="group" aria-label={zh ? "账单打印机" : "Receipt printer"}>
        <div className="receipt-printer-hand" aria-hidden="true" />
        <div className="receipt-printer-paper-window"><div className="receipt-printer-paper" style={paperStyle} role="button" tabIndex={printPhase === "ready" ? 0 : -1} aria-disabled={printPhase !== "ready"} aria-label={zh ? "拖动账单撕下并复制 PNG" : "Drag receipt to tear off and copy PNG"} onPointerDown={event => {
          if (printPhase !== "ready" || tearGesture.current || (event.pointerType === "mouse" && event.button !== 0)) return;
          event.preventDefault();
          tearGesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, position: { x: 0, y: 0 } };
          setDragging(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }} onPointerMove={event => { const gesture = tearGesture.current; if (gesture?.pointerId === event.pointerId) updateTearPosition(event, gesture); }} onPointerUp={event => stopTear(event, false)} onPointerCancel={event => stopTear(event, true)} onKeyDown={event => {
          if (printPhase === "ready" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void copyTornReceipt(); }
        }}><span>CODEX / {zh ? "任务账单" : "RECEIPT"}</span><b>{known.length ? money(total) : "—"}</b><i>{chosen.length} {zh ? "项任务" : "tasks"}</i></div></div>
        <div className="receipt-printer-body" aria-hidden="true"><span className="receipt-printer-light" /><span className="receipt-printer-slot" /></div>
      </div>}
      {printPhase === "ready" && <p className="receipt-printer-hint">{zh ? "拖动纸条撕下" : "Drag the paper to tear it off"}</p>}
      {printPhase === "success" && <p className="custom-statistics-feedback" role="status">{zh ? "账单已放进剪贴板" : "Receipt copied to clipboard"}</p>}
      {printPhase === "error" && <p className="custom-statistics-feedback" role="alert">{copyError}</p>}
      {loading ? <p>{zh ? "正在读取任务统计…" : "Loading task statistics…"}</p> : !rows.length ? <p>{error ? (zh ? "任务统计暂不可用。" : "Task statistics unavailable.") : (zh ? "这段时间暂无可归属的任务记录。" : "No attributed tasks in this period.")}</p> : <ul>
        {sorted.map(row => { const cost = row.estimatedCostUsd ?? row.knownCostUsd; return <li key={row.id}><label>
          <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
          <span className="custom-task-name"><span>{row.rawName}</span><small>{[row.projectName, row.sourceDevice ? `${zh ? "来自" : "From"} ${row.sourceDevice}` : null, row.self.id.slice(-8), row.children.length ? (zh ? `含 ${row.children.length} 个子 Agent` : `${row.children.length} subagents`) : null].filter(Boolean).join(" · ")}</small></span>
          <span className="custom-task-cost">{cost == null ? (zh ? "暂无估算" : "Estimate unavailable") : money(cost)}{cost != null && (row.estimatedCostUsd == null || row.costIncomplete) && <small>{zh ? "仅已知金额" : "Known amount only"}</small>}</span>
        </label></li>; })}
      </ul>}
      {(partial || error) && <p className="usage-note">{error ? (zh ? "刷新失败，显示上次任务快照。" : "Refresh failed; showing previous tasks.") : (zh ? "部分任务记录尚未同步或扫描完成。" : "Some task records are not yet synced or scanned.")}</p>}
    </div>}
  </section>;
}
