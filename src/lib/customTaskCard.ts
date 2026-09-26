import { formatTokens, type AggregatedTaskUsage } from "./tokeiUsage";

const COLORS = { background: "#eaf0f6", paper: "#fffef9", blue: "#7898ad", dark: "#293f52", muted: "#728696", yellow: "#ffe397", line: "#c9d8e1" };
const FONT = '"Smiley Sans", "得意黑", sans-serif';
const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rowCost = (row: AggregatedTaskUsage) => row.estimatedCostUsd ?? row.knownCostUsd;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function fitText(ctx: CanvasRenderingContext2D, value: string, width: number) {
  if (ctx.measureText(value).width <= width) return value;
  let result = value;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > width) result = result.slice(0, -1);
  return `${result}…`;
}

function dottedRule(ctx: CanvasRenderingContext2D, y: number) {
  ctx.fillStyle = COLORS.line;
  for (let x = 76; x < 644; x += 17) ctx.fillRect(x, y, 9, 2);
}

export function drawCustomTaskCard(rows: AggregatedTaskUsage[], periodLabel: string, zh: boolean): HTMLCanvasElement {
  if (!rows.length || rows.length > 100) throw new Error(zh ? "请选择 1–100 项任务" : "Select 1–100 tasks");
  const width = 720;
  const height = 392 + rows.length * 82;
  if (height * 2 > 16384) throw new Error(zh ? "所选任务太多，请分批导出" : "Too many tasks; export in batches");
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(zh ? "无法生成图片" : "Could not render image");
  ctx.scale(2, 2);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  roundRect(ctx, 38, 20, 644, height - 40, 12, COLORS.paper);
  ctx.fillStyle = COLORS.blue;
  ctx.fillRect(38, 20, 644, 11);
  ctx.textBaseline = "top";
  ctx.fillStyle = COLORS.dark;
  ctx.font = `32px ${FONT}`;
  ctx.fillText(zh ? "任务账单" : "TASK RECEIPT", 76, 59);
  ctx.textAlign = "right";
  ctx.font = `18px ${FONT}`;
  ctx.fillText(zh ? "CODEX · 用量" : "CODEX · USAGE", 644, 69);
  ctx.textAlign = "left";
  dottedRule(ctx, 121);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `18px ${FONT}`;
  ctx.fillText(fitText(ctx, periodLabel, 420), 76, 139);
  ctx.textAlign = "right";
  ctx.fillText(`${rows.length} ${zh ? "项任务" : "tasks"}`, 644, 139);
  ctx.textAlign = "left";

  const known = rows.map(rowCost).filter((value): value is number => value != null);
  const unknown = rows.filter(row => row.estimatedCostUsd == null || row.costIncomplete).length;
  const total = known.reduce((sum, value) => sum + value, 0);
  const tokens = formatTokens(rows.reduce((sum, row) => sum + row.totalTokens, 0), zh);
  roundRect(ctx, 76, 188, 568, 78, 11, COLORS.yellow);
  ctx.fillStyle = COLORS.dark;
  ctx.font = `20px ${FONT}`;
  ctx.fillText(unknown ? (zh ? "已知金额" : "KNOWN AMOUNT") : (zh ? "成本合计" : "TOTAL COST"), 96, 203);
  ctx.font = `40px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(known.length ? money(total) : (zh ? "暂无估算" : "Unavailable"), 624, 205);
  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.muted;
  ctx.font = `18px ${FONT}`;
  ctx.fillText(fitText(ctx, `${tokens} Tokens${unknown ? ` · ${unknown} ${zh ? "项成本不全" : "incomplete"}` : ""}`, 560), 76, 279);
  dottedRule(ctx, 318);

  rows.forEach((row, index) => {
    const y = 340 + index * 82;
    const cost = rowCost(row);
    ctx.fillStyle = COLORS.dark;
    ctx.font = `23px ${FONT}`;
    ctx.fillText(fitText(ctx, row.rawName || row.name, 425), 76, y);
    ctx.textAlign = "right";
    ctx.fillText(cost == null ? (zh ? "暂无估算" : "Unavailable") : money(cost), 644, y);
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.muted;
    ctx.font = `16px ${FONT}`;
    const detail = [row.projectName, row.sourceDevice, cost != null && (row.estimatedCostUsd == null || row.costIncomplete) ? (zh ? "仅已知金额" : "Known only") : null].filter(Boolean).join(" · ") || `${formatTokens(row.totalTokens, zh)} Tokens`;
    ctx.fillText(fitText(ctx, detail, 568), 76, y + 35);
    dottedRule(ctx, y + 68);
  });
  ctx.fillStyle = COLORS.muted;
  ctx.font = `16px ${FONT}`;
  ctx.fillText(zh ? "任务含子 Agent，合计只计一次" : "Subagents included; counted once", 76, height - 48);
  ctx.fillStyle = COLORS.blue;
  for (let x = 76; x < 644; x += 11) ctx.fillRect(x, height - 25, (x % 3) + 2, 9);
  return canvas;
}

export async function prepareCustomTaskCardFont(): Promise<void> {
  if (!document.fonts?.load) return;
  await document.fonts.load(`23px ${FONT}`);
}

export async function copyCustomTaskCard(rows: AggregatedTaskUsage[], periodLabel: string, zh: boolean): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error(zh ? "当前系统不支持复制 PNG" : "PNG clipboard is unavailable");
  }
  const canvas = drawCustomTaskCard(rows, periodLabel, zh);
  // Begin the clipboard write in the tear-click's activation turn. WKWebView can
  // reject writes that only start after asynchronous PNG encoding or animation.
  const png = new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(zh ? "无法生成 PNG" : "Could not create PNG")), "image/png"));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
