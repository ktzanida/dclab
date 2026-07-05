// Shared helpers: formatting, flags, chart theme.

export function flagEmoji(code) {
  const iso = { EL: "GR", UK: "GB" }[code] || code;
  if (iso === "XK") return "🏴"; // no official flag emoji for Kosovo
  return [...iso].map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join("");
}

export const fmt = {
  num(v, digits = 1) {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    return v.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  },
};

export function baseAxis(extra = {}) {
  return {
    axisLine: { lineStyle: { color: "#232d3b" } },
    axisLabel: { color: "#7d8da0", fontSize: 11 },
    splitLine: { lineStyle: { color: "#1a222e" } },
    ...extra,
  };
}

export function makeChart(el) {
  const chart = echarts.init(el, null, { renderer: "canvas" });
  new ResizeObserver(() => chart.resize()).observe(el);
  return chart;
}

export const TOOLTIP_STYLE = {
  backgroundColor: "#1c2532",
  borderColor: "#232d3b",
  textStyle: { color: "#e6edf3", fontSize: 12 },
};
