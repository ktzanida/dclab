// Noise Lab view: place a data center on a real map, see its noise plume.
// Physics lives in noise-model.js (ISO 9613-2 / ISO 9613-1); this file is the
// map, the plume raster + contours, and the controls/readouts around them.

import {
  BANDS, SOURCE_KINDS, airAbsorption, buildScenario, computeGrid, distanceTo,
  levelAt, ratingLevel, suggestExtent,
} from "./noise-model.js";
import { baseAxis, fmt, makeChart, TOOLTIP_STYLE } from "./util.js";
import { buildTechPicker, facility } from "./facility.js";

const GRID_N = 121;      // receptors per side
const CANVAS_PX = 560;   // rendered raster, bilinearly upsampled from the grid
const CONTOURS = [35, 40, 45, 50, 55, 60, 65, 70];
const M_PER_DEG_LAT = 111320;

const METRIC_LABEL = { day: "daytime LAeq", night: "night LAeq (Lnight)", den: "Lden (24 h)" };

// Typical outdoor background levels (LA90-ish) by area character — the anchor
// for the "blends into background" contour. Indicative, user-visible values.
const AMBIENT = {
  rural: { day: 42, night: 30 },
  suburban: { day: 50, night: 37 },
  urban: { day: 58, night: 45 },
};

// Lightness-monotone "inferno" ramp: dark violet (faint) → bright yellow (loud).
// Magnitude reads as brightness — correct for a sequential field on a dark map.
const RAMP_DB = [32, 76];
const RAMP = ["#000004", "#160b39", "#420a68", "#6a176e", "#932667", "#ba3655",
  "#dd513a", "#f37819", "#fca50a", "#f6d746", "#fcffa4"].map((hex) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));

function rampColor(db) {
  const t = Math.min(1, Math.max(0, (db - RAMP_DB[0]) / (RAMP_DB[1] - RAMP_DB[0])));
  const x = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((k) => RAMP[i][k] + (RAMP[i + 1][k] - RAMP[i][k]) * f);
}

function rampAlpha(db) {
  if (db <= RAMP_DB[0]) return 0;
  const t = Math.min(1, (db - RAMP_DB[0]) / 28); // full presence by ~60 dB
  return Math.round(185 * Math.pow(t, 0.75));    // cap ≈ 0.73 so the map shows through
}

// What a level *feels* like — the bridge between dB and everyday experience.
const FEELS = [
  [75, "shouting distance from a motorway"],
  [70, "vacuum cleaner in the room"],
  [65, "loud conversation right next to you"],
  [60, "normal conversation at 1 m"],
  [55, "a dishwasher running nearby"],
  [50, "moderate rainfall"],
  [45, "a quiet suburb by day"],
  [40, "a library reading room"],
  [35, "a quiet bedroom at night"],
  [-Infinity, "rural night — rustling leaves"],
];
const feels = (db) => FEELS.find(([lim]) => db >= lim)[1];

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

const state = {
  map: null, marker: null, overlay: null, buildingRect: null, wallRect: null,
  lat: facility.lat, lon: facility.lon, // mirrors of the shared facility site
  canvas: null, chart: null,
  grid: null, half: 0, scenario: null, env: null, params: null,
};

const $ = (id) => document.getElementById(id);
const segVal = (id) => document.querySelector(`#${id} .active`)?.dataset.val;

// ------------------------------------------------------------------ parameters

function readOverrides() {
  const overrides = {};
  for (const { kind } of SOURCE_KINDS) {
    const lwa = parseFloat($(`nz-lw-${kind}`)?.value);
    const count = parseInt($(`nz-ct-${kind}`)?.value, 10);
    const o = {};
    if (Number.isFinite(lwa)) o.lwa = lwa;
    if (Number.isFinite(count)) o.count = count;
    if (Object.keys(o).length) overrides[kind] = o;
  }
  return overrides;
}

function readParams() {
  return {
    mw: facility.mw,
    cooling: facility.tech,
    metric: segVal("nz-metric") ?? "day",
    gensetTest: $("nz-gen").checked,
    pkg: $("nz-pkg").checked,
    rating: $("nz-rating").checked,
    unc: $("nz-unc").checked,
    met: segVal("nz-met") ?? "worst",
    windDeg: +$("nz-wind").value,
    area: $("nz-area").value,
    wallH: +$("nz-wall").value,
    G: +$("nz-ground").value,
    hr: +$("nz-rcv").value,
    tempC: +$("nz-temp").value,
    rh: +$("nz-rh").value,
  };
}

function writeHash(p) {
  const q = new URLSearchParams({
    lat: state.lat.toFixed(5), lon: state.lon.toFixed(5),
    mw: p.mw, cool: p.cooling, metric: p.metric,
    gen: +p.gensetTest, pkg: +p.pkg, rating: +p.rating, unc: +p.unc,
    met: p.met, wind: p.windDeg, area: p.area,
    wall: p.wallH, gnd: p.G, rcv: p.hr, t: p.tempC, rh: p.rh,
  });
  const ov = Object.entries(p.overrides ?? {})
    .map(([k, o]) => `${k}:${o.lwa ?? ""}:${o.count ?? ""}`).join("~");
  if (ov) q.set("ov", ov);
  history.replaceState(null, "", `#noise?${q}`);
}

function applyHash() {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  if (!q.has("lat")) return;
  const fac = { lat: +q.get("lat"), lon: +q.get("lon") || facility.lon };
  if (q.has("mw")) fac.mw = +q.get("mw");
  if (q.has("cool")) fac.tech = q.get("cool");
  facility.set(fac, "hash-noise");
  const num = (k, el) => { if (q.has(k)) $(el).value = q.get(k); };
  num("wall", "nz-wall"); num("gnd", "nz-ground");
  num("t", "nz-temp"); num("rh", "nz-rh"); num("wind", "nz-wind");
  num("area", "nz-area"); num("rcv", "nz-rcv");
  const check = (k, el) => { if (q.has(k)) $(el).checked = q.get(k) === "1"; };
  check("gen", "nz-gen"); check("pkg", "nz-pkg");
  check("rating", "nz-rating"); check("unc", "nz-unc");
  const seg = (k, id) => {
    if (!q.has(k)) return;
    document.querySelectorAll(`#${id} button`).forEach((b) =>
      b.classList.toggle("active", b.dataset.val === q.get(k)));
  };
  seg("metric", "nz-metric"); seg("met", "nz-met");
  for (const part of (q.get("ov") ?? "").split("~")) {
    const [kind, lwa, count] = part.split(":");
    if ($(`nz-lw-${kind}`)) {
      $(`nz-lw-${kind}`).value = lwa ?? "";
      $(`nz-ct-${kind}`).value = count ?? "";
    }
  }
}

// --------------------------------------------------------------- raster + lines

function bilinear(grid, gx, gy) {
  const i = Math.min(GRID_N - 2, Math.floor(gx)), j = Math.min(GRID_N - 2, Math.floor(gy));
  const fx = gx - i, fy = gy - j;
  const g00 = grid[j * GRID_N + i], g10 = grid[j * GRID_N + i + 1];
  const g01 = grid[(j + 1) * GRID_N + i], g11 = grid[(j + 1) * GRID_N + i + 1];
  return g00 * (1 - fx) * (1 - fy) + g10 * fx * (1 - fy) + g01 * (1 - fx) * fy + g11 * fx * fy;
}

function drawPlume(grid, opts) {
  const W = CANVAS_PX;
  const canvas = state.canvas;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, W);
  const data = img.data;
  for (let py = 0; py < W; py++) {
    const gy = (1 - py / (W - 1)) * (GRID_N - 1); // canvas row 0 = north = grid j max
    for (let px = 0; px < W; px++) {
      const db = bilinear(grid, (px / (W - 1)) * (GRID_N - 1), gy);
      const a = rampAlpha(db);
      const o = (py * W + px) * 4;
      if (a > 0) {
        const [r, g, b] = rampColor(db);
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  drawContours(ctx, grid, opts);
}

// One marching-squares pass over the sim grid for one iso-level, in pixel space.
function traceLevel(ctx, grid, level) {
  const n = GRID_N, W = CANVAS_PX;
  const px = (i) => (i / (n - 1)) * W;
  const py = (j) => (1 - j / (n - 1)) * W;
  ctx.beginPath();
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const v00 = grid[j * n + i], v10 = grid[j * n + i + 1];
      const v01 = grid[(j + 1) * n + i], v11 = grid[(j + 1) * n + i + 1];
      let c = 0;
      if (v00 >= level) c |= 1;
      if (v10 >= level) c |= 2;
      if (v11 >= level) c |= 4;
      if (v01 >= level) c |= 8;
      if (c === 0 || c === 15) continue;
      const lerp = (a, b) => (level - a) / (b - a);
      const eB = [px(i + lerp(v00, v10)), py(j)];
      const eR = [px(i + 1), py(j + lerp(v10, v11))];
      const eT = [px(i + lerp(v01, v11)), py(j + 1)];
      const eL = [px(i), py(j + lerp(v00, v01))];
      const SEGS = {
        1: [[eL, eB]], 2: [[eB, eR]], 3: [[eL, eR]], 4: [[eR, eT]],
        5: [[eL, eT], [eB, eR]], 6: [[eB, eT]], 7: [[eL, eT]], 8: [[eT, eL]],
        9: [[eT, eB]], 10: [[eT, eR], [eL, eB]], 11: [[eT, eR]],
        12: [[eR, eL]], 13: [[eR, eB]], 14: [[eB, eL]],
      };
      for (const [a, b] of SEGS[c]) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    }
  }
  ctx.stroke();
}

// Outermost eastward crossing of `level` on the horizontal centerline, or null.
function eastCrossing(grid, level) {
  const n = GRID_N, jc = (n - 1) / 2;
  for (let i = n - 2; i > jc; i--) {
    const a = grid[jc * n + i], b = grid[jc * n + i + 1];
    if ((a >= level) !== (b >= level)) {
      return [((i + (level - a) / (b - a)) / (n - 1)) * CANVAS_PX, CANVAS_PX / 2];
    }
  }
  return null;
}

// opts: { ambient: dB | null (audibility contour), unc: bool (±3 dB bands) }
function drawContours(ctx, grid, opts) {
  const labelAt = [];
  for (const level of CONTOURS) {
    const major = level === 45 || level === 55; // common night / day limits
    if (opts.unc && major) { // the honest fuzz: same line, ±3 dB companions
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = "rgba(255,255,255,0.30)";
      ctx.lineWidth = 1;
      traceLevel(ctx, grid, level - 3);
      traceLevel(ctx, grid, level + 3);
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = major ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.28)";
    ctx.lineWidth = major ? 1.6 : 1;
    traceLevel(ctx, grid, level);
    const at = eastCrossing(grid, level);
    if (at) labelAt.push([at[0], at[1], `${level}`, major, "#ffffff"]);
  }

  if (opts.ambient != null) { // where the plant blends into the local soundscape
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = "rgba(34,211,238,0.75)";
    ctx.lineWidth = 1.4;
    traceLevel(ctx, grid, opts.ambient);
    ctx.setLineDash([]);
    const at = eastCrossing(grid, opts.ambient);
    if (at) labelAt.push([at[0], at[1] + 16, "≈ background", true, "#22d3ee"]);
  }

  // outermost labels win; drop any that would crowd an already-placed one
  labelAt.sort((a, b) => b[0] - a[0]);
  const spaced = labelAt.filter((l, i, arr) => i === 0 || arr[i - 1][0] - l[0] > 30);

  ctx.font = "600 11px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  for (const [x, y, text, major, color] of spaced) {
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "rgba(8,10,16,0.85)";
    ctx.strokeText(text, x, y - 5);
    ctx.fillStyle = major ? color : "rgba(255,255,255,0.75)";
    ctx.fillText(text, x, y - 5);
  }
}

// ------------------------------------------------------------------- recompute

function mPerDegLon() { return M_PER_DEG_LAT * Math.cos((state.lat * Math.PI) / 180); }

function toLocal(latlng) {
  return [
    (latlng.lng - state.lon) * mPerDegLon(),
    (latlng.lat - state.lat) * M_PER_DEG_LAT,
  ];
}

// The displayed field at a point: LAeq, or the rating level when the
// tonal-character penalty is switched on.
function fieldAt(x, y) {
  const { laeq, tonalDb } = levelAt(state.scenario, state.env, x, y);
  return state.params.rating ? ratingLevel(laeq, tonalDb) : laeq;
}

function recompute() {
  const p = readParams();
  p.overrides = readOverrides();
  $("nz-mw-out").textContent = `${p.mw} MW`;
  $("nz-wall-out").textContent = p.wallH > 0 ? `${p.wallH} m` : "none";
  $("nz-temp-out").textContent = `${p.tempC} °C`;
  $("nz-rh-out").textContent = `${p.rh} %`;
  $("nz-wind-out").textContent = `from ${COMPASS[Math.round(p.windDeg / 45) % 8]} (${p.windDeg}°)`;
  $("nz-wind-row").classList.toggle("hidden", p.met !== "avg");

  const t0 = performance.now();
  const scenario = buildScenario(p);
  const env = {
    alpha: airAbsorption(p.tempC, p.rh), G: p.G,
    wallH: p.wallH, S: scenario.wallDist, hr: p.hr,
    c0max: p.met === "avg" ? 3 : 0,
    // sound is carried TOWARD downwind = wind bearing + 180°, in math convention
    windTo: ((90 - (p.windDeg + 180)) * Math.PI) / 180,
  };
  Object.assign(state, { scenario, env, params: p });

  const half = suggestExtent(fieldAt, 28);
  const { laeq, tonal } = computeGrid(scenario, env, half, GRID_N);
  const disp = p.rating
    ? Float32Array.from(laeq, (l, k) => ratingLevel(l, tonal[k]))
    : laeq;
  const ambient = p.metric === "den" ? null : AMBIENT[p.area][p.metric];
  drawPlume(disp, { ambient, unc: p.unc });
  const ms = performance.now() - t0;

  Object.assign(state, { grid: disp, half });

  const dLat = half / M_PER_DEG_LAT, dLon = half / mPerDegLon();
  state.overlay.setUrl(state.canvas.toDataURL());
  state.overlay.setBounds([
    [state.lat - dLat, state.lon - dLon], [state.lat + dLat, state.lon + dLon]]);

  drawFootprint(scenario, p);
  renderResults(p, scenario, env, half, ms);
  writeHash(p);
}

let pending = null;
function scheduleRecompute(delay = 120) {
  clearTimeout(pending);
  pending = setTimeout(recompute, delay);
}

function drawFootprint(scenario, p) {
  const s2 = scenario.side / 2, w2 = scenario.wallDist;
  const rect = (half) => [
    [state.lat - half / M_PER_DEG_LAT, state.lon - half / mPerDegLon()],
    [state.lat + half / M_PER_DEG_LAT, state.lon + half / mPerDegLon()],
  ];
  if (state.buildingRect) state.buildingRect.setBounds(rect(s2));
  else state.buildingRect = L.rectangle(rect(s2), {
    color: "#fbbf24", weight: 1.2, fillColor: "#fbbf24", fillOpacity: 0.12, interactive: false,
  }).addTo(state.map);

  if (state.wallRect) state.wallRect.remove(), state.wallRect = null;
  if (p.wallH > 0) {
    state.wallRect = L.rectangle(rect(w2), {
      color: "#e6edf3", weight: 1, dashArray: "4 5", fill: false, interactive: false,
    }).addTo(state.map);
  }
}

// --------------------------------------------------------------------- results

function renderResults(p, scenario, env, half, ms) {
  $("nz-lwa").textContent = scenario.totalLwa.toFixed(0);
  const notes = [METRIC_LABEL[p.metric]];
  if (p.gensetTest) {
    notes.push(p.metric === "day" ? "generators on test"
      : "generator test shown in Day view only");
  }
  if (p.rating) notes.push("rating level (+5 dB where tonal hum is audible)");
  if (p.met === "avg") notes.push("long-term average, prevailing wind");
  $("nz-mode").textContent = notes.join(" · ");
  $("nz-meta").textContent =
    `${(GRID_N * GRID_N).toLocaleString("en-GB")} receptors × ${scenario.sources.length} sources × 8 octave bands — ${ms.toFixed(0)} ms · ISO 9613-2${p.met === "avg" ? " + §8 Cmet" : " downwind"}, ±3 dB`;

  $("nz-dist-title").textContent = `How far the noise reaches — ${METRIC_LABEL[p.metric]}`;
  const maxR = half * 1.5;
  const ROWS = [
    [55, "common daytime residential limit"],
    [50, "sounds like steady rain"],
    [45, "common night-time limit"],
    [40, "WHO night guideline territory"],
    [35, "fades into a quiet bedroom"],
  ];
  const ambient = p.metric === "den" ? null : AMBIENT[p.area][p.metric];
  if (ambient != null && !ROWS.some(([db]) => db === ambient)) {
    ROWS.push([ambient, `≈ ${p.area} background — blends in beyond this`]);
    ROWS.sort((a, b) => b[0] - a[0]);
  }
  $("nz-dist").innerHTML = ROWS.map(([db, note]) => {
    const r = distanceTo(fieldAt, scenario.wallDist, db, maxR);
    const rTxt = r <= scenario.wallDist ? "inside the site"
      : r >= 1000 ? `${(r / 1000).toFixed(r >= 10000 ? 0 : 1)} km` : `${Math.round(r / 10) * 10} m`;
    const isAmb = db === ambient;
    return `<tr><td class="nz-db mono" style="color:${isAmb ? "#22d3ee" : `rgb(${rampColor(db).map(Math.round)})`}">${db}</td>
      <td class="mono">${rTxt}</td><td class="nz-note">${note}</td></tr>`;
  }).join("");

  $("nz-groups").innerHTML = scenario.groups
    .slice().sort((a, b) => b.groupLwa - a.groupLwa)
    .map((g) => `<tr><td>${g.label}${g.tonal ? " <span class='nz-dim'>tonal</span>" : ""}</td>
      <td class="mono">${g.count}×</td>
      <td class="mono">${g.groupLwa.toFixed(0)} dB(A)</td></tr>`).join("");

  // Octave spectrum at a fixed reference receptor, 250 m east of the fence
  const at = levelAt(scenario, env, scenario.wallDist + 250, 0);
  const shown = p.rating ? ratingLevel(at.laeq, at.tonalDb) : at.laeq;
  $("nz-spec-title").textContent =
    `What you'd hear 250 m from the fence — ${shown.toFixed(0)} dB(A) · ${feels(shown)}`;
  const peak = at.bands.indexOf(Math.max(...at.bands));
  state.chart.setOption({
    grid: { left: 46, right: 6, top: 14, bottom: 36 },
    tooltip: {
      ...TOOLTIP_STYLE,
      formatter: (h) => `${h.name} Hz band<br><b>${fmt.num(h.value, 1)} dB(A)</b>`,
    },
    xAxis: baseAxis({
      type: "category", data: BANDS.map((f) => (f >= 1000 ? `${f / 1000}k` : f)),
      name: "octave band · Hz", nameLocation: "middle", nameGap: 24,
      nameTextStyle: { color: "#617080", fontSize: 10 },
      splitLine: { show: false }, axisLabel: { color: "#7d8da0", fontSize: 10 },
    }),
    yAxis: baseAxis({
      type: "value", min: 0, name: "sound level · dB(A)",
      nameLocation: "middle", nameGap: 30,
      nameTextStyle: { color: "#617080", fontSize: 10 },
      axisLabel: { color: "#7d8da0", fontSize: 10 },
    }),
    series: [{
      type: "bar", barWidth: "62%",
      data: at.bands.map((v, i) => ({
        value: Math.max(0, +v.toFixed(1)),
        label: i === peak ? {
          show: true, position: "top", color: "#e6edf3", fontSize: 10,
          formatter: ({ value }) => `${Math.round(value)}`,
        } : undefined,
      })),
      itemStyle: { color: "#fca50a", borderRadius: [4, 4, 0, 0] },
    }],
  });
}

// ----------------------------------------------------------------------- setup

function buildLegend() {
  const stops = RAMP.map((c, i) =>
    `rgb(${c.map(Math.round)}) ${(i / (RAMP.length - 1)) * 100}%`).join(",");
  const marks = [[70, "vacuum cleaner"], [60, "conversation"], [55, "day limit"],
    [50, "steady rain"], [45, "night limit"], [40, "library"], [35, "quiet bedroom"]];
  $("nz-legend").innerHTML = `
    <div class="nz-legend-title">dB(A) — what it sounds like</div>
    <div class="nz-legend-body">
      <div class="nz-legend-bar" style="background:linear-gradient(to top, ${stops})"></div>
      <div class="nz-legend-marks">${marks.map(([db, txt]) => {
        const pct = ((db - RAMP_DB[0]) / (RAMP_DB[1] - RAMP_DB[0])) * 100;
        return `<div class="nz-legend-mark" style="bottom:${pct}%">
          <span class="mono">${db}</span> ${txt}</div>`;
      }).join("")}
      </div>
    </div>`;
}

function buildSourceEditor() {
  $("nz-sources-edit").innerHTML = SOURCE_KINDS.map(({ kind, label, defaultLwa }) => `
    <div class="nz-src-row">
      <span class="nz-src-label">${label}</span>
      <label>LwA <input type="number" id="nz-lw-${kind}" placeholder="${defaultLwa}"
        min="60" max="130" step="1"></label>
      <label>count <input type="number" id="nz-ct-${kind}" placeholder="auto"
        min="0" max="500" step="1"></label>
    </div>`).join("");
  $("nz-sources-edit").querySelectorAll("input").forEach((el) =>
    el.addEventListener("input", () => scheduleRecompute(250)));
}

export async function initNoise() {
  buildSourceEditor();
  const syncTech = buildTechPicker($("nz-tech"), "noise");
  applyHash();
  state.lat = facility.lat; state.lon = facility.lon;
  $("nz-mw").value = facility.mw;

  const map = L.map("noise-map", {
    zoomControl: false, attributionControl: false, maxZoom: 18, minZoom: 6,
  }).setView([state.lat, state.lon], 13);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", maxZoom: 19,
    attribution: "© OpenStreetMap contributors © CARTO",
  }).addTo(map);
  state.map = map;

  state.canvas = document.createElement("canvas");
  state.canvas.width = CANVAS_PX;
  state.canvas.height = CANVAS_PX;
  state.overlay = L.imageOverlay(
    "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=", // 1px placeholder
    [[state.lat, state.lon], [state.lat, state.lon]],
    { opacity: 1, interactive: false, className: "nz-plume" },
  ).addTo(map);

  state.marker = L.marker([state.lat, state.lon], {
    draggable: true, autoPan: true,
    icon: L.divIcon({
      className: "nz-dc-icon",
      html: `<div class="nz-ring"></div><div class="nz-ring nz-ring-2"></div><div class="nz-core">🏢</div>`,
      iconSize: [46, 46], iconAnchor: [23, 23],
    }),
  }).addTo(map);

  const moveTo = (lat, lon) => facility.set({ lat, lon }, "noise");
  state.marker.on("drag", (e) => moveTo(e.latlng.lat, e.latlng.lng));
  map.on("click", (e) => moveTo(e.latlng.lat, e.latlng.lng));

  // the shared facility drives this lab — whoever changed it
  facility.subscribe((patch, src) => {
    $("nz-mw").value = facility.mw;
    $("nz-mw-out").textContent = `${facility.mw} MW`;
    syncTech();
    if (patch.lat !== undefined || patch.lon !== undefined) {
      state.lat = facility.lat; state.lon = facility.lon;
      state.marker.setLatLng([state.lat, state.lon]);
      $("nz-site").textContent = `📍 ${state.lat.toFixed(4)}, ${state.lon.toFixed(4)} — drag the building or click the map to move it`;
      if (src !== "noise") map.setView([state.lat, state.lon]);
      scheduleRecompute(60);
    } else {
      scheduleRecompute(src === "noise" ? 100 : 250);
    }
  });

  // live readout under the cursor — the exact model, not the raster
  const hover = $("nz-hover");
  map.on("mousemove", (e) => {
    if (!state.scenario) return;
    const [x, y] = toLocal(e.latlng);
    const r = Math.hypot(x, y);
    if (r > state.half * 1.45) { hover.hidden = true; return; }
    const at = levelAt(state.scenario, state.env, x, y);
    const shown = state.params.rating ? ratingLevel(at.laeq, at.tonalDb) : at.laeq;
    const penalized = state.params.rating && shown > at.laeq;
    const pt = map.latLngToContainerPoint(e.latlng);
    hover.style.left = `${pt.x + 16}px`;
    hover.style.top = `${pt.y - 14}px`;
    hover.innerHTML = `<b>${shown.toFixed(0)} dB(A)</b> · ${feels(shown)}
      <span class="nz-hover-dist">${r >= 1000 ? `${(r / 1000).toFixed(1)} km` : `${Math.round(r)} m`} from site${penalized ? " · incl. +5 dB tonal penalty" : ""}</span>`;
    hover.hidden = false;
  });
  map.getContainer().addEventListener("mouseleave", () => { hover.hidden = true; });

  // controls
  for (const id of ["nz-metric", "nz-met"]) {
    document.querySelectorAll(`#${id} button`).forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll(`#${id} button`).forEach((x) =>
          x.classList.toggle("active", x === b));
        scheduleRecompute(0);
      }));
  }
  $("nz-mw").addEventListener("input", () =>
    facility.set({ mw: +$("nz-mw").value }, "noise"));
  ["nz-wall", "nz-temp", "nz-rh", "nz-wind"].forEach((id) =>
    $(id).addEventListener("input", () => scheduleRecompute()));
  ["nz-gen", "nz-pkg", "nz-rating", "nz-unc", "nz-ground", "nz-area", "nz-rcv"].forEach((id) =>
    $(id).addEventListener("change", () => scheduleRecompute(0)));

  $("nz-share").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("nz-share").textContent = "✓ link copied";
      setTimeout(() => ($("nz-share").textContent = "🔗 copy share link"), 1600);
    } catch { /* clipboard unavailable — URL is already in the address bar */ }
  });

  state.chart = makeChart($("nz-spectrum"));
  buildLegend();
  requestAnimationFrame(() => map.invalidateSize());

  moveTo(facility.lat, facility.lon); // schedules the first compute
}

// ------------------------------------------------------------------- report
//
// Snapshot of the current run for the PDF report (report.js). Tables are the
// already-rendered DOM fragments; images come from the spectrum chart and the
// plume raster (contours + labels; the basemap is tile-licensed and omitted).

export function getNoiseReport() {
  if (!state.grid || !state.params || !state.scenario) return null;
  // charts collapse to 0×0 while their view is hidden — report.js polls this
  // until the view is visible and laid out again
  if (!state.chart || state.chart.getWidth() < 10) return null;
  const p = state.params;
  const flags = [
    p.gensetTest && "generator test",
    p.pkg && "acoustic mitigation package",
    p.rating && "rating level (+5 dB tonal penalty)",
  ].filter(Boolean).join(", ") || "none";
  try {
    return snapshot(p, flags);
  } catch {
    return null; // mid-layout race — the poller will retry
  }
}

function snapshot(p, flags) {
  return {
    lwa: state.scenario.totalLwa.toFixed(0), mode: $("nz-mode").textContent,
    settings: [
      ["Metric", $("nz-mode").textContent.split(" · ")[0]],
      ["Perimeter wall", p.wallH > 0 ? `${p.wallH} m` : "none"],
      ["Ground", { 0: "hard", 0.5: "mixed", 1: "soft" }[p.G] ?? p.G],
      ["Area character", p.area],
      ["Meteorology", p.met === "avg"
        ? `long-term average, wind from ${p.windDeg}°` : "downwind worst case"],
      ["Air", `${p.tempC} °C · ${p.rh} % RH`],
      ["Receptor height", `${p.hr} m`],
      ["Options", flags],
    ],
    distTitle: $("nz-dist-title").textContent,
    distHTML: $("nz-dist").innerHTML,
    groupsHTML: $("nz-groups").innerHTML,
    specTitle: $("nz-spec-title").textContent,
    spectrumImg: state.chart.getDataURL({ pixelRatio: 2, backgroundColor: "#0f141c" }),
    plumeImg: state.canvas.toDataURL(),
    plumeHalf: state.half,
    meta: $("nz-meta").textContent,
    lat: state.lat, lon: state.lon,
  };
}
