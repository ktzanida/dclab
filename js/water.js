// Water Lab view — map as the epicentre, like the Noise Lab.
//
// The map carries the spatial story water actually has: every country is
// tinted by its WEI+ water-stress band (can the place afford it?), the site
// is a draggable droplet, and two rings around it show the facility's demand
// as the area of irrigated farmland it could have watered instead — a
// footprint you can compare against the real fields on the basemap. The
// right-hand panel holds the controls and the numbers, noise-lab style.
//
// Thermodynamics live in water-model.js; data (Open-Meteo climate, Eurostat
// stress + grid mix, bundled geometry) in data.js — all fetched by the
// visitor's browser, no backend anywhere. A site move fetches one weather
// year (8,760+ hourly temperature & humidity values) and the country's water
// context; everything else recomputes locally in milliseconds, so sliders
// feel alive.

import {
  TECHS, compareTechs, perspective, simulate, upstreamM3, weiBand,
} from "./water-model.js";
import { data } from "./data.js";
import { buildTechPicker, facility } from "./facility.js";
import { addBasemap, baseAxis, flagEmoji, fmt, makeChart, TOOLTIP_STYLE } from "./util.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Validated two-series water palette (light = the salient share, deep = the rest):
// CVD ΔE ≥ 40 on all axes against the app's dark surface.
const C_LIGHT = "#67e8f9";
const C_DEEP = "#0e7490";
const ACCENT = "#38bdf8";

const IRRIGATION_M3_PER_HA = 6000; // southern-European irrigated maize (FAO)

const state = {
  lat: facility.lat, lon: facility.lon, country: "EL", countryName: "Greece",
  climate: null, context: null, weiMap: null, geo: null,
  map: null, marker: null, ringTotal: null, ringEvap: null,
  charts: {}, // monthly, compare, wei
  sim: null, params: null,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ parameters

function readParams() {
  return {
    tech: facility.tech,
    mwIT: facility.mw,
    util: +$("wl-util").value / 100,
    coc: +$("wl-coc").value,
    adbSwitchC: +$("wl-adb").value,
    hydro: $("wl-hydro").checked,
    gridOverride: parseFloat($("wl-grid-l").value),
    popK: +$("wl-pop").value, // host-utility population, thousands
  };
}

function gridIntensity(p) {
  if (Number.isFinite(p.gridOverride)) return { l: p.gridOverride, label: "user-set" };
  const g = state.context?.grid;
  if (!g) return { l: 1.0, label: "EU-typical default (no mix data)" };
  return {
    l: p.hydro ? g.intensity_incl_hydro_l_per_kwh : g.intensity_l_per_kwh,
    label: `${state.country} ${g.year} generation mix`,
  };
}

function writeHash(p) {
  const q = new URLSearchParams({
    lat: state.lat.toFixed(4), lon: state.lon.toFixed(4), cc: state.country,
    mw: p.mwIT, util: Math.round(p.util * 100), tech: p.tech,
    coc: p.coc, adb: p.adbSwitchC, hydro: +p.hydro,
  });
  q.set("pop", p.popK);
  if (Number.isFinite(p.gridOverride)) q.set("gl", p.gridOverride);
  history.replaceState(null, "", `#water?${q}`);
}

function applyHash() {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  if (!q.has("lat")) return;
  const fac = { lat: +q.get("lat"), lon: +q.get("lon") || facility.lon };
  if (q.has("mw")) fac.mw = +q.get("mw");
  if (q.has("tech")) fac.tech = q.get("tech");
  facility.set(fac, "hash-water");
  if (q.has("cc")) state.country = q.get("cc"); // fallback if the site is offshore
  const num = (k, el) => { if (q.has(k)) $(el).value = q.get(k); };
  num("util", "wl-util"); num("coc", "wl-coc");
  num("adb", "wl-adb"); num("gl", "wl-grid-l"); num("pop", "wl-pop");
  if (q.has("hydro")) $("wl-hydro").checked = q.get("hydro") === "1";
}

// ------------------------------------------------------------------ formatting

const m3 = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : fmt.num(v, 0);
const m3u = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(2)} M m³` : `${fmt.num(v, 0)} m³`;

// ----------------------------------------------------- point-in-country lookup
//
// Ray casting over the bundled GISCO 1:20m polygons — coarse but exactly as
// coarse as the choropleth itself, and instant. Used when the droplet is
// dragged or a click lands outside the country layer.

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function countryAt(lat, lon) {
  for (const f of state.geo?.features ?? []) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const rings of polys) {
      if (inRing(lon, lat, rings[0]) && !rings.slice(1).some((r) => inRing(lon, lat, r))) {
        return f.properties;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------- recompute

function recompute() {
  if (!state.climate) return;
  const p = readParams();
  $("wl-mw").value = facility.mw;
  $("wl-mw-out").textContent = `${p.mwIT} MW`;
  $("wl-util-out").textContent = `${Math.round(p.util * 100)} %`;
  $("wl-coc-out").textContent = `${p.coc}×`;
  $("wl-adb-out").textContent = `${p.adbSwitchC} °C`;
  $("wl-coc-row").classList.toggle("hidden", p.tech !== "towers");
  $("wl-adb-row").classList.toggle("hidden", p.tech !== "adiabatic");

  const t0 = performance.now();
  const sim = simulate(state.climate, p);
  const all = compareTechs(state.climate, p);
  const grid = gridIntensity(p);
  const ms = performance.now() - t0;

  Object.assign(state, { sim, params: p, lastGrid: grid });
  drawRings(sim);
  renderPanel(p, sim, all, grid);
  $("wl-meta").textContent =
    `${state.climate.t2m.length.toLocaleString("en-GB")} h × ${TECHS.length} technologies — ${ms.toFixed(0)} ms · ` +
    `Open-Meteo ERA5 ${state.climate.year} · Eurostat sdg_06_60 + nrg_bal_peh · Macknick 2012 factors`;
  writeHash(p);
}

let pending = null;
function scheduleRecompute(delay = 80) {
  clearTimeout(pending);
  pending = setTimeout(recompute, delay);
}

// ------------------------------------------------------------ equivalence rings
//
// The annual demand, drawn as the circle of irrigated farmland it equals:
// area = m³ / 6,000 m³ per ha. Outer dashed ring = total draw; inner filled
// ring = the consumed (evaporated) share. Zoom in to compare against the
// real fields around the site.

function ringRadius(m3yr) {
  const ha = m3yr / IRRIGATION_M3_PER_HA;
  return Math.sqrt((ha * 1e4) / Math.PI); // meters
}

function drawRings(sim) {
  const center = [state.lat, state.lon];
  const rT = ringRadius(sim.makeupM3);
  const rE = ringRadius(sim.evapM3);
  const haT = sim.makeupM3 / IRRIGATION_M3_PER_HA;

  if (!state.ringTotal) {
    state.ringTotal = L.circle(center, {
      radius: 1, color: ACCENT, weight: 1.6, dashArray: "6 5",
      fill: false, interactive: true,
    }).addTo(state.map);
    state.ringEvap = L.circle(center, {
      radius: 1, color: C_LIGHT, weight: 1,
      fillColor: C_LIGHT, fillOpacity: 0.12, interactive: false,
    }).addTo(state.map);
  }
  state.ringTotal.setLatLng(center).setRadius(Math.max(rT, 1));
  state.ringEvap.setLatLng(center).setRadius(Math.max(rE, 1));
  state.ringTotal.unbindTooltip();
  state.ringTotal.bindTooltip(
    `annual draw ≈ irrigation water for ${haT >= 20 ? fmt.num(haT, 0) : haT.toFixed(1)} ha — this circle · ` +
    `filled ring: the evaporated (consumed) share`,
    { direction: "top", className: "wl-ring-tip" });
}

// --------------------------------------------------------------------- panel

function renderPanel(p, sim, all, grid) {
  const tech = TECHS.find((t) => t.key === p.tech);
  const clim = state.climate;
  const persp = perspective(sim.makeupM3, sim.peakDayM3);
  const wei = state.context?.wei?.latest;

  $("wl-site").innerHTML =
    `📍 ${state.lat.toFixed(2)}, ${state.lon.toFixed(2)} — ` +
    `${flagEmoji(state.country)} ${state.countryName}` +
    `${wei ? ` · WEI+ <b style="color:${weiBand(wei.value).color}">${wei.value.toFixed(1)} %</b>` : ""} · ` +
    `drag the droplet or click the map`;

  // headline
  $("wl-makeup").textContent = m3(sim.makeupM3);
  $("wl-split").innerHTML =
    `<b>${m3u(sim.evapM3)}</b> evaporated (consumed) · <b>${m3u(sim.blowdownM3)}</b> returned as blowdown`;
  $("wl-wue").textContent = sim.wue.toFixed(2);
  $("wl-pue").textContent = sim.pue.toFixed(2);
  $("wl-peak").textContent = fmt.num(sim.peakDayM3, 0);
  const peakDate = new Date(Date.UTC(clim.year, 0, 1 + sim.peakDayIdx));
  $("wl-climate").innerHTML =
    `${tech.label} · weather year ${clim.year} (${clim.source}) · ` +
    `design wet-bulb ${sim.design.twbMax.toFixed(1)} °C · hottest hour ${sim.design.tdbMax.toFixed(1)} °C · ` +
    `compressor-free ${Math.round(sim.freeCoolShare * 100)} % of hours` +
    (sim.peakDayM3 >= 1
      ? ` · peak water day ${peakDate.toLocaleDateString("en-GB", { day: "numeric", month: "long" })} — the number a permit is sized on`
      : "");

  // perspective table
  const rows = [
    ["🚰", fmt.num(persp.people, 0), "people's total domestic water use", "EU average, 120 L/person·day"],
    ["🏊", persp.pools >= 20 ? fmt.num(persp.pools, 0) : persp.pools.toFixed(1),
      "Olympic swimming pools per year", "2,500 m³ each"],
    ["🌽", persp.irrigatedHa >= 20 ? fmt.num(persp.irrigatedHa, 0) : persp.irrigatedHa.toFixed(1),
      "hectares of irrigated farmland", "the dashed ring on the map"],
    ["🚛", fmt.num(persp.tankersPeakDay, 0), "road tankers on the peak day", "30 m³ each, if the mains failed"],
  ];
  $("wl-persp").innerHTML = rows.map(([ico, val, label, sub]) => `
    <tr><td class="wl-persp-ico">${ico}</td>
    <td class="mono wl-persp-val">${val}</td>
    <td>${label} <span class="nz-note">— ${sub}</span></td></tr>`).join("");

  renderMonthly(sim);
  renderCompare(p, all, grid);
  renderStress(sim, persp);
  renderFate(sim, p);
  renderAbout(p, grid);
}

// monthly profile
function renderMonthly(sim) {
  const evap = sim.month.evap.map((v) => Math.round(v));
  const blow = sim.month.blowdown.map((v) => Math.round(v));
  const jja = (sim.month.makeup[5] + sim.month.makeup[6] + sim.month.makeup[7]) /
    Math.max(1, sim.makeupM3);
  state.charts.monthly.setOption({
    grid: { left: 66, right: 6, top: 30, bottom: 36 },
    legend: {
      top: 0, right: 0, textStyle: { color: "#9fb0c0", fontSize: 10.5 },
      itemWidth: 11, itemHeight: 8,
      data: ["Evaporated (consumed)", "Blowdown (returned)"],
    },
    tooltip: {
      ...TOOLTIP_STYLE, trigger: "axis",
      formatter: (items) => {
        const m = items[0].dataIndex;
        const rows = items.map((it) =>
          `${it.marker} ${it.seriesName}: <b>${fmt.num(it.value, 0)} m³</b>`).join("<br>");
        return `<b>${MONTHS[m]}</b><br>${rows}<br>` +
          `avg ${sim.month.tAvg[m].toFixed(1)} °C · compressor-free ` +
          `${Math.round((sim.month.freeHours[m] / Math.max(1, sim.month.hours[m])) * 100)} % of hours`;
      },
    },
    xAxis: baseAxis({
      type: "category", data: MONTHS.map((s) => s[0]), splitLine: { show: false },
      name: "month", nameLocation: "middle", nameGap: 22,
      nameTextStyle: { color: "#617080", fontSize: 10 },
      axisLabel: { color: "#7d8da0", fontSize: 10 },
    }),
    yAxis: baseAxis({
      type: "value", name: "water · m³ / month",
      nameLocation: "middle", nameGap: 50,
      nameTextStyle: { color: "#617080", fontSize: 10 },
      axisLabel: { color: "#7d8da0", fontSize: 10 },
    }),
    series: [
      { name: "Evaporated (consumed)", type: "bar", stack: "w", data: evap,
        barWidth: "58%", itemStyle: { color: C_LIGHT } },
      { name: "Blowdown (returned)", type: "bar", stack: "w", data: blow,
        itemStyle: { color: C_DEEP, borderColor: "#0f141c", borderWidth: 1,
          borderRadius: [3, 3, 0, 0] } },
    ],
  });
  $("wl-monthly-cap").innerHTML = sim.makeupM3 < 1
    ? "This technology rejects heat dry — no meaningful monthly water profile."
    : `<b>${Math.round(jja * 100)} %</b> of the annual demand falls in June–August —
       exactly when rivers and reservoirs are lowest. Permits and drought plans are
       decided on months like these, not on annual averages.`;
}

// technology trade-off (on-site + upstream, all techs, same site)
function renderCompare(p, all, grid) {
  const rows = all.map((s) => ({
    key: s.tech,
    label: TECHS.find((t) => t.key === s.tech).short,
    site: s.makeupM3,
    up: upstreamM3(s, grid.l),
    pue: s.pue, wue: s.wue,
  })).sort((a, b) => (a.site + a.up) - (b.site + b.up));

  state.charts.compare.setOption({
    grid: { left: 104, right: 66, top: 30, bottom: 36 },
    legend: {
      top: 0, right: 0, textStyle: { color: "#9fb0c0", fontSize: 10.5 },
      itemWidth: 11, itemHeight: 8,
      data: ["On-site", "Upstream (electricity)"],
    },
    tooltip: {
      ...TOOLTIP_STYLE, trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (items) => {
        const r = rows[items[0].dataIndex];
        return `<b>${r.label}</b>${r.key === p.tech ? " (selected)" : ""}<br>
          on-site: <b>${m3u(r.site)}</b> · upstream: <b>${m3u(r.up)}</b><br>
          total: <b>${m3u(r.site + r.up)}</b>/yr · WUE ${r.wue.toFixed(2)} · PUE ${r.pue.toFixed(2)}`;
      },
    },
    xAxis: baseAxis({
      type: "value", name: "water footprint · m³ / year",
      nameLocation: "middle", nameGap: 24,
      nameTextStyle: { color: "#617080", fontSize: 10 },
      axisLabel: {
        color: "#7d8da0", fontSize: 10,
        formatter: (v) => v >= 1e6 ? `${v / 1e6}M` : v >= 1000 ? `${v / 1000}k` : v,
      },
    }),
    yAxis: baseAxis({
      type: "category", data: rows.map((r) => r.label), splitLine: { show: false },
      axisLabel: {
        color: "#9fb0c0", fontSize: 10.5,
        formatter: (v) => rows.find((r) => r.label === v)?.key === p.tech ? `{sel|▸ ${v}}` : v,
        rich: { sel: { color: ACCENT, fontWeight: 600, fontSize: 10.5 } },
      },
    }),
    series: [
      { name: "On-site", type: "bar", stack: "w",
        data: rows.map((r) => Math.round(r.site)),
        barWidth: "55%", itemStyle: { color: C_LIGHT } },
      { name: "Upstream (electricity)", type: "bar", stack: "w",
        data: rows.map((r) => Math.round(r.up)),
        itemStyle: { color: C_DEEP, borderColor: "#0f141c", borderWidth: 1,
          borderRadius: [0, 3, 3, 0] },
        label: {
          show: true, position: "right", color: "#9fb0c0", fontSize: 9.5,
          formatter: ({ dataIndex }) => m3(rows[dataIndex].site + rows[dataIndex].up),
        } },
    ],
  });

  $("wl-compare-cap").innerHTML =
    `<b>“Water-free” cooling isn't water-free.</b> Dry cooling moves demand upstream —
     its extra electricity was generated with water (${grid.l.toFixed(2)} L/kWh on the
     ${grid.label}). But on-site draw hits <em>this</em> basin; upstream water is
     consumed wherever the power plants sit. Siting and grid mix decide the right trade.`;
}

// water stress
function renderStress(sim, persp) {
  const wei = state.context?.wei;
  const latest = wei?.latest ?? null;
  const band = weiBand(latest?.value);
  $("wl-wei").textContent = latest ? `${latest.value.toFixed(1)} %` : "–";
  $("wl-wei").style.color = band.color;
  $("wl-wei-band").textContent = latest
    ? `${band.label} · WEI+ ${latest.year}` : "no WEI+ data for this country";
  $("wl-wei-band").style.color = band.color;

  const pos = latest ? Math.min(100, (latest.value / 50) * 100) : null;
  $("wl-wei-scale").innerHTML = `
    <div class="wl-scale-bar">
      <span style="flex:20;background:#34d39933"></span>
      <span style="flex:20;background:#fbbf2433"></span>
      <span style="flex:40;background:#f9731633"></span>
      <span style="flex:20;background:#ef444433"></span>
      ${pos != null ? `<i style="left:${pos}%"></i>` : ""}
    </div>
    <div class="wl-scale-marks mono"><span>0</span><span>10</span><span>20</span><span>40</span><span>50+</span></div>`;

  const years = Object.keys(wei?.series ?? {}).map(Number);
  state.charts.wei.setOption({
    grid: { left: 4, right: 4, top: 6, bottom: 4 },
    xAxis: { type: "category", show: false, data: years },
    yAxis: { type: "value", show: false, min: 0 },
    tooltip: {
      ...TOOLTIP_STYLE,
      formatter: (h) => `${h.name}: <b>${fmt.num(h.value, 1)} %</b>`,
    },
    series: [{
      type: "line", data: years.map((y) => wei.series[y]),
      symbol: "circle", symbolSize: 4, lineStyle: { color: band.color, width: 1.5 },
      itemStyle: { color: band.color }, areaStyle: { color: `${band.color}22` },
    }],
  });

  const eu = wei?.eu_latest;
  $("wl-stress-text").innerHTML = latest ? `
    <p>${state.countryName} consumes <b>${latest.value.toFixed(1)} %</b> of its renewable
       freshwater resources (WEI+${eu ? `; EU average ${eu.value.toFixed(1)} %` : ""}).
       The EEA reads <b>&gt;20 % as water stress</b>, &gt;40 % as severe.</p>`
    : `<p>No WEI+ value is published for this country. The physics above still holds —
       check the river-basin authority's own scarcity indicators.</p>`;

  renderImpact(sim, persp, latest);
}

// "This facility's slice" — the same consumption at the two scales that
// matter: the national index (honest answer: usually invisible) and the
// host community's water utility (honest answer: very visible). Bridging
// those two is exactly what siting debates get wrong in both directions.

const PUBLIC_SUPPLY_M3_PER_CAP = 75; // m³/person·yr total public supply: households (~40–50 m³, 77 % of it) + services + losses (EEA/Eurostat)

function renderImpact(sim, persp, latest) {
  const res = state.context?.wei?.resources;
  const popK = state.params.popK;
  $("wl-pop-out").textContent = `${fmt.num(popK * 1000, 0)} people`;

  // national: ΔWEI+ from the facility's consumptive (evaporated) share
  if (res) {
    const dWei = (sim.evapM3 / (res.mio_m3 * 1e6)) * 100; // percentage points
    const verdict = dWei < 0.01 ? "invisible at national scale"
      : dWei < 0.1 ? "barely visible even nationally"
      : "visible even at national scale";
    $("wl-impact-nat").innerHTML =
      `<b>Nationally:</b> consuming ${m3u(sim.evapM3)}/yr raises ${state.countryName}'s
       WEI+ by <b>+${dWei < 0.01 ? dWei.toFixed(4) : dWei.toFixed(2)} points</b>` +
      (latest ? ` (${latest.value.toFixed(2)} → ${(latest.value + dWei).toFixed(dWei < 0.01 ? 4 : 2)} %)` : "") +
      ` — ${verdict}. <span class="nz-dim">(renewable resources: ${fmt.num(res.mio_m3, 0)} M m³/yr, ${res.source})</span>`;
  } else {
    $("wl-impact-nat").innerHTML =
      `<b>Nationally:</b> no renewable-resource volume is published for
       ${state.countryName}, so the index shift can't be computed — judge it at the
       local scale below.`;
  }

  // local: share of the host utility's annual public supply
  const utilityM3 = popK * 1000 * PUBLIC_SUPPLY_M3_PER_CAP;
  const share = (sim.makeupM3 / utilityM3) * 100;
  const [color, verdict] =
    share < 1 ? ["#34d399", "a rounding error for the utility"] :
    share < 5 ? ["#fbbf24", "a big customer — needs supply planning"] :
    share < 15 ? ["#f97316", "a major new demand — likely new infrastructure"] :
    ["#ef4444", "utility-scale — needs its own source or reclaimed water"];
  $("wl-impact-loc").innerHTML =
    `<b>Locally:</b> the full draw (${m3u(sim.makeupM3)}/yr) equals
     <b style="color:${color}">${share < 10 ? share.toFixed(1) : Math.round(share)} %</b>
     of the annual supply of a utility serving ${fmt.num(popK * 1000, 0)} people —
     <span style="color:${color}">${verdict}</span>. This, not the national index,
     is the scale where the decision lands: ${fmt.num(persp.people, 0)}
     person-equivalents of consumption arrive on <em>one</em> connection.`;
}

// where the water goes
function renderFate(sim, p) {
  const rows = [
    [sim.evapM3, "evaporated to the atmosphere", "consumed — gone from the local water balance"],
    [sim.blowdownM3, "blowdown to sewer / surface water",
      `returned, ~${p.coc}× mineral concentration — discharge consent needed`],
  ];
  $("wl-fate").innerHTML = sim.makeupM3 < 1
    ? `<tr><td colspan="3" class="nz-note">Dry heat rejection — only sanitary and
       technical water remains (~${m3u(sim.makeupM3)}/yr).</td></tr>`
    : rows.filter(([v]) => v > 0.5).map(([v, what, note]) => {
      const pct = Math.round((v / sim.makeupM3) * 100);
      return `<tr><td class="mono" style="color:${ACCENT};width:96px">${m3u(v)}</td>
        <td>${what} <span class="nz-dim">(${pct} %)</span></td>
        <td class="nz-note">${note}</td></tr>`;
    }).join("");
  $("wl-fate-cap").innerHTML =
    `Consumption ≠ withdrawal: permits, EU taxonomy reporting and the German EnEfG ask
     for both. Evaporation competes with rivers, crops and taps; blowdown is what the
     wastewater utility sees.`;
}

// assumptions
function renderAbout(p, grid) {
  const g = state.context?.grid;
  const clim = state.climate;
  const mixRows = (g?.mix ?? []).slice(0, 8).map((m) =>
    `<tr><td>${m.label}</td><td class="mono">${(m.share * 100).toFixed(1)} %</td>
     <td class="mono">${m.l_per_kwh} L/kWh</td></tr>`).join("");
  $("wl-about").innerHTML = `
    <h4>The physics</h4>
    <p>Every hour of the <b>${clim.year} weather year</b> at your site (ERA5 reanalysis via
       Open-Meteo, fetched by your browser) is run through the chosen cooling plant's
       control sequence. Wet-bulb temperature comes from dry-bulb and humidity via Stull
       (2011), ±0.3 °C. Evaporative heat rejection is anchored to the latent heat of
       vaporization: <b>1.48 L of water per kWh of heat</b> rejected latently.
       Cooling towers reject compressor heat too (COP-dependent), evaporate a temperature-
       dependent share of it (~62 % near freezing → ~95 % on hot days), and bleed blowdown
       at your cycles-of-concentration setting: makeup = evaporation × (1 + 1/(CoC−1)).
       Adiabatic pads and direct-evaporative media are modelled by the energy balance of the
       air-temperature depression they achieve toward wet-bulb (65 % / 85 % effectiveness).</p>
    <h4>The control sequences</h4>
    <p>Water-side economizers run compressor-free below 8 °C wet-bulb and ramp to full
       mechanical by 14 °C; dry coolers do the same on dry-bulb (8→16 °C); the 40 °C liquid
       loop stays dry below ~32 °C with a 25 % air-cooled slice for non-liquid IT. Chiller
       COP follows typical modern curves (water-cooled ≈ 9.5 − 0.16·T<sub>wb</sub>;
       air-cooled ≈ 5.8 − 0.075·T<sub>db</sub>), plus fan/pump parasitics and a 6 % electrical
       + 5.5 % distribution overhead — that is the whole PUE model, disclosed.</p>
    <h4>Upstream water</h4>
    <p>Electricity consumes water where it is generated. The ${state.countryName} factor —
       <b>${grid.l.toFixed(2)} L/kWh</b> (${grid.label}) — weights the country's actual
       generation mix (Eurostat <span class="mono">nrg_bal_peh</span>${g ? `, ${g.year}` : ""})
       by per-technology operational consumption medians from <b>Macknick et al. 2012</b>
       (recirculating cooling). Hydro reservoir evaporation (5 L/kWh mid-range) is
       ${p.hydro ? "included" : "excluded"} — attribution of multi-purpose reservoirs is
       genuinely contested, so it's a toggle, not a buried constant.</p>
    ${mixRows ? `<table class="wl-mix-table"><tr><th>Generation</th><th>share</th><th>water</th></tr>${mixRows}</table>` : ""}
    <h4>The map layers</h4>
    <p>Country tint is the latest <b>WEI+</b> (Eurostat <span class="mono">sdg_06_60</span>):
       water consumption as a share of renewable freshwater resources, banded per EEA at
       10 / 20 / 40 %. The rings turn the annual demand into <b>irrigated-farmland
       equivalent</b> (6,000 m³/ha·yr, southern-European maize): dashed = total draw,
       filled = the evaporated share. Zoom in and compare them with the real fields.</p>
    <h4>Scale anchors</h4>
    <p>Olympic pool 2,500 m³ · EU domestic use 120 L/person/day (EEA) · public water
       supply ≈ 75 m³/person·yr incl. services and network losses (the "host utility"
       slider) · national renewable freshwater volumes from Eurostat
       <span class="mono">env_wat_res</span> (FAO AQUASTAT long-term averages where
       Eurostat has no data) · road tanker 30 m³.</p>
    <h4>Cross-checked against published numbers</h4>
    <p>Every constant above carries a citation, and the model's outputs are validated
       against published facility data (Meta's Talavera campus planning figures,
       hyperscaler fleet WUE reports, the Uptime Institute PUE survey, Macknick's
       water-factor medians) — see <a href="REFERENCES.md" target="_blank"
       rel="noopener">REFERENCES.md</a> in the app folder for the full source list
       and the model-vs-published comparison table.</p>
    <h4>What it deliberately ignores</h4>
    <p>Flat IT load (no diurnal shape), no water-treatment losses on the makeup side, no
       reclaimed/sea-water sourcing (both excellent mitigations — this model prices the
       default: drinking-quality mains), country-level WEI+ instead of the basin-and-season
       truth, and a single real weather year (${clim.year}) rather than a design envelope —
       hotter years run thirstier, cooler ones less so. This is a <b>screening tool</b> to
       make siting, technology and disclosure debates concrete; a permit needs the
       operator's measured WUE, the basin authority's balance, and the utility's
       abstraction data. For scale: hyperscalers report fleet WUE between 0.2 and
       1.1 L/kWh; surveys of conventional evaporative sites cluster near 1.8.</p>`;
}

// ----------------------------------------------------------------------- site

const moveTo = (lat, lon) => facility.set({ lat, lon }, "water");

let sitePending = null;
function onFacilityChange(patch, src) {
  if (!state.map) return;
  syncTech();
  const siteChanged = patch.lat !== undefined || patch.lon !== undefined;
  if (siteChanged) {
    state.lat = facility.lat;
    state.lon = facility.lon;
    const c = countryAt(state.lat, state.lon);
    if (c) { state.country = c.id; state.countryName = c.name; }
    state.marker.setLatLng([state.lat, state.lon]);
    if (src !== "water") state.map.setView([state.lat, state.lon]);
    $("wl-site").textContent =
      `📍 ${state.lat.toFixed(2)}, ${state.lon.toFixed(2)} — ${c ? c.name : "open water?"} · loading…`;
    clearTimeout(sitePending);
    sitePending = setTimeout(loadSite, 350); // settle before fetching a weather year
  } else {
    scheduleRecompute(src === "water" ? 80 : 250);
  }
}
let syncTech = () => {};

let siteReq = 0;
async function loadSite() {
  const req = ++siteReq;
  $("wl-loading").hidden = false;
  $("wl-loading").textContent = "Fetching the site's weather year…";
  $("wl-body").style.opacity = 0.4;
  try {
    const [climate, context] = await Promise.all([
      data.climate(state.lat, state.lon),
      data.context(state.country).catch(() => null),
    ]);
    if (req !== siteReq) return; // a newer click superseded this one
    state.climate = climate;
    state.context = context;
    $("wl-loading").hidden = true;
    $("wl-body").style.opacity = 1;
    recompute();
  } catch (err) {
    if (req !== siteReq) return;
    $("wl-loading").hidden = false;
    $("wl-loading").innerHTML = `<span class="err">⚠ ${err.message}</span>`;
    $("wl-body").style.opacity = 0.4;
  }
}

// ----------------------------------------------------------------------- setup

function buildLegend() {
  const bands = [
    ["#34d399", "< 10 %", "low stress"],
    ["#fbbf24", "10–20 %", "moderate"],
    ["#f97316", "20–40 %", "water stress"],
    ["#ef4444", "> 40 %", "severe"],
    ["#64748b", "–", "no data"],
  ];
  $("wl-legend").innerHTML = `
    <div class="wl-legend-title">Water stress — WEI+</div>
    ${bands.map(([c, range, label]) => `
      <div class="wl-legend-row">
        <span class="wl-legend-swatch" style="background:${c}66;border:1px solid ${c}"></span>
        <span class="mono">${range}</span> ${label}
      </div>`).join("")}
    <div class="nz-dim" style="margin-top:6px">consumption ÷ renewable freshwater<br>(Eurostat, latest year · EEA bands)</div>`;
}

export async function initWater() {
  syncTech = buildTechPicker($("wl-tech"), "water");
  buildLegend();
  applyHash();
  state.lat = facility.lat; state.lon = facility.lon;
  $("wl-mw").value = facility.mw;

  const map = L.map("water-map", {
    zoomControl: false, attributionControl: false, minZoom: 4, maxZoom: 15,
  }).setView([state.lat, state.lon], 6);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  addBasemap(map);
  state.map = map;

  // WEI+ choropleth + country hover/click
  const [geo, weiMap] = await Promise.all([
    data.geo(),
    data.weiMap().catch(() => null),
  ]);
  state.geo = geo;
  state.weiMap = weiMap;
  L.geoJSON(geo, {
    style: (f) => {
      const v = weiMap?.countries?.[f.properties.id]?.value ?? null;
      const band = weiBand(v);
      return { fillColor: band.color, fillOpacity: v == null ? 0.06 : 0.18,
        color: band.color, opacity: v == null ? 0.25 : 0.5, weight: 0.8 };
    },
    onEachFeature: (feature, layer) => {
      const w = weiMap?.countries?.[feature.properties.id];
      layer.bindTooltip(
        `${feature.properties.name} — WEI+ ${w ? `${w.value.toFixed(1)} % (${weiBand(w.value).label}, ${w.year})` : "no data"}`,
        { sticky: true, direction: "top" });
      layer.on("click", (ev) => moveTo(ev.latlng.lat, ev.latlng.lng));
    },
  }).addTo(map);
  map.on("click", (e) => moveTo(e.latlng.lat, e.latlng.lng)); // sea / outside the layer

  // draggable droplet, like the noise lab's building
  state.marker = L.marker([state.lat, state.lon], {
    draggable: true, autoPan: true,
    icon: L.divIcon({
      className: "wl-dc-icon",
      html: `<div class="wl-ring"></div><div class="wl-ring wl-ring-2"></div><div class="wl-core">💧</div>`,
      iconSize: [46, 46], iconAnchor: [23, 23],
    }),
  }).addTo(map);
  state.marker.on("dragend", (e) => {
    const { lat, lng } = e.target.getLatLng();
    moveTo(lat, lng);
  });
  facility.subscribe(onFacilityChange);

  state.charts.monthly = makeChart($("wl-monthly"));
  state.charts.compare = makeChart($("wl-compare"));
  state.charts.wei = makeChart($("wl-wei-trend"));

  $("wl-mw").addEventListener("input", () =>
    facility.set({ mw: +$("wl-mw").value }, "water"));
  ["wl-util", "wl-coc", "wl-adb", "wl-pop"].forEach((id) =>
    $(id).addEventListener("input", () => scheduleRecompute()));
  ["wl-hydro", "wl-grid-l"].forEach((id) =>
    $(id).addEventListener("change", () => scheduleRecompute(0)));

  $("wl-share").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("wl-share").textContent = "✓ link copied";
      setTimeout(() => ($("wl-share").textContent = "🔗 copy share link"), 1600);
    } catch { /* clipboard unavailable — URL is already in the address bar */ }
  });

  requestAnimationFrame(() => map.invalidateSize());
  moveTo(state.lat, state.lon); // first load
}

// ------------------------------------------------------------------- report
//
// Snapshot of the current run for the PDF report (report.js).

export function getWaterReport() {
  if (!state.sim || !state.climate || !state.params) return null;
  // charts collapse to 0×0 while their view is hidden — poll until laid out
  for (const c of Object.values(state.charts)) {
    if (!c || c.getWidth() < 10) return null;
  }
  try {
    return snapshot();
  } catch {
    return null; // mid-layout race — the poller will retry
  }
}

function snapshot() {
  const p = state.params, sim = state.sim, grid = state.lastGrid;
  const img = (c) => c.getDataURL({ pixelRatio: 2, backgroundColor: "#0f141c" });
  const wei = state.context?.wei?.latest;
  return {
    country: state.country, countryName: state.countryName,
    settings: [
      ["Average IT load", `${Math.round(p.util * 100)} %`],
      ["Cycles of concentration", p.tech === "towers" ? `${p.coc}×` : "—"],
      ["Adiabatic switchover", p.tech === "adiabatic" ? `${p.adbSwitchC} °C` : "—"],
      ["Grid water intensity", `${grid.l.toFixed(2)} L/kWh (${grid.label})`],
      ["Hydro reservoir evaporation", p.hydro ? "included (5 L/kWh)" : "excluded"],
      ["Host utility", `${fmt.num(p.popK * 1000, 0)} people`],
    ],
    makeup: m3u(sim.makeupM3), splitHTML: $("wl-split").innerHTML,
    wue: sim.wue.toFixed(2), pue: sim.pue.toFixed(2),
    peak: `${fmt.num(sim.peakDayM3, 0)} m³`,
    climateLine: $("wl-climate").textContent,
    perspHTML: $("wl-persp").innerHTML,
    monthlyImg: img(state.charts.monthly), monthlyCap: $("wl-monthly-cap").innerHTML,
    compareImg: img(state.charts.compare), compareCap: $("wl-compare-cap").innerHTML,
    wei: wei ? `${wei.value.toFixed(1)} % — ${weiBand(wei.value).label} (WEI+ ${wei.year})` : "no WEI+ data",
    weiImg: img(state.charts.wei),
    stressHTML: $("wl-stress-text").innerHTML,
    impactNatHTML: $("wl-impact-nat").innerHTML,
    impactLocHTML: $("wl-impact-loc").innerHTML,
    fateHTML: $("wl-fate").innerHTML, fateCap: $("wl-fate-cap").innerHTML,
    meta: $("wl-meta").textContent,
    lat: state.lat, lon: state.lon,
    ringTotalM: ringRadius(sim.makeupM3),
    ringEvapM: ringRadius(sim.evapM3),
    ringHa: sim.makeupM3 / IRRIGATION_M3_PER_HA,
  };
}
