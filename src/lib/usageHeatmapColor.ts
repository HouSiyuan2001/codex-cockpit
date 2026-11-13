/** Established blue-to-red scale for the reset-risk heatmap. */
const STOPS = [[0, 48, 91, 132], [50, 150, 207, 211], [68, 255, 224, 164], [84, 250, 159, 72], [100, 230, 88, 81]] as const;
const CALENDAR_PALETTES = {
  codex: {
    stops: [[0, 216, 235, 247], [25, 166, 198, 221], [50, 115, 157, 189], [75, 72, 116, 151], [100, 39, 80, 119]],
    zero: "rgb(78, 102, 126)",
  },
  claude: {
    stops: [[0, 255, 231, 207], [25, 255, 196, 140], [50, 239, 138, 71], [75, 199, 106, 56], [100, 161, 70, 31]],
    zero: "rgb(221, 203, 187)",
  },
} as const;

export type CalendarHeatmapPalette = keyof typeof CALENDAR_PALETTES;

function interpolateColor(stops: readonly (readonly number[])[], value: number, min: number, max: number): string {
  const percent = max > min ? Math.min(100, Math.max(0, (value - min) / (max - min) * 100)) : 0;
  const upper = Math.max(1, stops.findIndex(([at]) => percent <= at));
  const a = stops[upper - 1], b = stops[upper];
  const t = Math.min(1, Math.max(0, (percent - a[0]) / (b[0] - a[0])));
  return `rgb(${a.slice(1).map((channel, index) => Math.round(channel + (b[index + 1] - channel) * t)).join(", ")})`;
}

export function usageHeatmapColor(value: number, min: number, max: number): string {
  return interpolateColor(STOPS, value, min, max);
}

export function calendarHeatmapColor(value: number, min: number, max: number, palette: CalendarHeatmapPalette = "codex"): string {
  const { stops, zero } = CALENDAR_PALETTES[palette];
  return value <= 0 ? zero : interpolateColor(stops, value, min, max);
}

export function calendarHeatmapGradient(palette: CalendarHeatmapPalette): string {
  const stops = CALENDAR_PALETTES[palette].stops.map(([at, red, green, blue]) => `rgb(${red}, ${green}, ${blue}) ${at}%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function contrastTextColor(color: string, darkInk = "#24324d", threshold = .32): string {
  const channels = color.match(/\d+/g)?.map(Number) ?? [48, 91, 132];
  const luminance = channels.reduce((sum, channel, index) => {
    const normalized = channel / 255;
    const linear = normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    return sum + linear * [.2126, .7152, .0722][index];
  }, 0);
  return luminance > threshold ? darkInk : "#ffffff";
}

export function usageHeatmapTextColor(value: number, min: number, max: number): string {
  return contrastTextColor(usageHeatmapColor(value, min, max));
}

export function calendarHeatmapTextColor(value: number, min: number, max: number, palette: CalendarHeatmapPalette = "codex"): string {
  const color = calendarHeatmapColor(value, min, max, palette);
  return palette === "claude" ? contrastTextColor(color, "#1a0a02", .19) : contrastTextColor(color);
}
