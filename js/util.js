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

// Basemap: Esri World Dark Gray Canvas — keyless and CORS-enabled (the PDF
// report composites the tiles onto a canvas). Base and labels come as separate
// layers, so labels can sit above the data overlays. Native tiles stop at z16;
// deeper zooms upscale.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
export const BASEMAP = {
  base: (z, x, y) => `${ESRI}/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
  labels: (z, x, y) => `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/${z}/${y}/${x}`,
  maxNativeZoom: 16,
  attribution: "© Esri, HERE, Garmin · © OpenStreetMap contributors",
};

export function addBasemap(map) {
  const opts = { maxNativeZoom: BASEMAP.maxNativeZoom, maxZoom: 19 };
  L.tileLayer(BASEMAP.base("{z}", "{x}", "{y}"), opts).addTo(map);
  const pane = map.createPane("labels");
  pane.style.zIndex = 450; // above overlayPane (400), below markers (600)
  pane.style.pointerEvents = "none";
  L.tileLayer(BASEMAP.labels("{z}", "{x}", "{y}"), { ...opts, pane }).addTo(map);
}
