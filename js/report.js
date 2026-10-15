// PDF report — one document, both labs, every number carrying its context.
//
// Strategy: browsers already ship a high-quality, paginating, vector PDF
// engine — the print dialog. We assemble a print-formatted report into
// #print-report (light theme via CSS-variable override, charts embedded as
// images off the live ECharts instances / the plume raster), make sure BOTH
// labs have computed (activating each behind an overlay if needed — chart
// canvases only have a size while their view is visible), then window.print().
//
// The result is reproducible: the report footer carries the share links that
// re-open both labs with exactly these parameters, plus the citation list
// (mirroring REFERENCES.md).

import { showView } from "./app.js";
import { facility } from "./facility.js";
import { getNoiseReport } from "./noise.js";
import { getWaterReport } from "./water.js";
import { TECHS } from "./water-model.js";
import { BASEMAP } from "./util.js";

const $ = (id) => document.getElementById(id);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out preparing the ${label}`);
    await wait(250);
  }
}

// ------------------------------------------------------- static map snapshots
//
// The Esri basemap tiles are CORS-enabled (verified: Access-Control-Allow-
// Origin: *), so we can composite the actual map around the chosen site into
// the report: tiles → canvas, overlays drawn in Web-Mercator pixel space,
// scale bar + attribution burned in. Any tile/canvas failure degrades to null
// and the report falls back to overlay-only figures.

const TILE = 256;
const M_PER_PX_Z0 = 156543.03392; // Web-Mercator ground resolution at z0, equator

function loadTile(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Render w×h px centered on (lat, lon), zoom fitted so ±halfM meters fit the
// width. draw(ctx, project, pxPerM) adds overlays; project(lat,lon) → [x,y].
async function mapSnapshot({ lat, lon, halfM, w, h, draw }) {
  try {
    const cos = Math.cos((lat * Math.PI) / 180);
    const z = Math.min(16, Math.max(4,
      Math.floor(Math.log2((M_PER_PX_Z0 * cos * w) / (2 * halfM)))));
    const world = TILE * 2 ** z;
    const mPerPx = (M_PER_PX_Z0 * cos) / 2 ** z;
    const toWorld = (la, lo) => {
      const r = (la * Math.PI) / 180;
      return [
        ((lo + 180) / 360) * world,
        ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * world,
      ];
    };
    const [cx, cy] = toWorld(lat, lon);
    const x0 = cx - w / 2, y0 = cy - h / 2;

    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0a0e14";
    ctx.fillRect(0, 0, w, h);

    // Base and label tiles load together; labels are drawn only after every
    // base tile so no base tile can paint over a neighbour's labels.
    const jobs = [];
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h) / TILE); ty++) {
      if (ty < 0 || ty >= 2 ** z) continue;
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w) / TILE); tx++) {
        const wx = ((tx % 2 ** z) + 2 ** z) % 2 ** z; // wrap the antimeridian
        jobs.push(Promise.all([
          loadTile(BASEMAP.base(z, wx, ty)), loadTile(BASEMAP.labels(z, wx, ty)),
        ]).then((imgs) => ({ imgs, dx: tx * TILE - x0, dy: ty * TILE - y0 })));
      }
    }
    const tiles = await Promise.all(jobs);
    for (const layer of [0, 1]) {
      for (const { imgs, dx, dy } of tiles) {
        if (imgs[layer]) ctx.drawImage(imgs[layer], dx, dy);
      }
    }

    const project = (la, lo) => {
      const [px, py] = toWorld(la, lo);
      return [px - x0, py - y0];
    };
    draw?.(ctx, project, 1 / mPerPx);
    drawScaleBar(ctx, w, h, mPerPx);
    ctx.font = "10px Inter, sans-serif";
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(BASEMAP.attribution, w - 8, h - 8);
    return canvas.toDataURL();
  } catch {
    return null;
  }
}

function drawScaleBar(ctx, w, h, mPerPx) {
  const target = mPerPx * (w / 5);
  const pow = 10 ** Math.floor(Math.log10(target));
  const nice = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= target);
  const px = nice / mPerPx;
  const y = h - 14, x = 12;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + px, y);
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
  ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4);
  ctx.stroke();
  ctx.font = "600 11px 'JetBrains Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, x, y - 8);
}

function drawMarker(ctx, x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, 2 * Math.PI);
  ctx.fillStyle = "#38bdf8";
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
}

// Banner: the locality + the water-equivalence rings, immediately readable.
function siteBanner(w) {
  return mapSnapshot({
    lat: facility.lat, lon: facility.lon,
    halfM: Math.max(2500, w.ringTotalM * 2.4), w: 1120, h: 400,
    draw(ctx, project, pxPerM) {
      const [x, y] = project(facility.lat, facility.lon);
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, w.ringEvapM * pxPerM, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(103,232,249,0.16)"; ctx.fill();
      ctx.strokeStyle = "rgba(103,232,249,0.8)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, w.ringTotalM * pxPerM, 0, 2 * Math.PI);
      ctx.setLineDash([7, 6]);
      ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 1.8; ctx.stroke();
      ctx.restore();
      drawMarker(ctx, x, y);
    },
  });
}

// Noise: the plume composited over the basemap at plume extent, exactly as
// the app shows it (screen blend over the dark tiles).
async function noisePlumeMap(n) {
  const plume = new Image();
  plume.src = n.plumeImg;
  await plume.decode().catch(() => null);
  return mapSnapshot({
    lat: n.lat, lon: n.lon, halfM: n.plumeHalf, w: 900, h: 900,
    draw(ctx, project) {
      const dLat = n.plumeHalf / 111320;
      const dLon = n.plumeHalf / (111320 * Math.cos((n.lat * Math.PI) / 180));
      const [x0, y0] = project(n.lat + dLat, n.lon - dLon); // NW corner
      const [x1, y1] = project(n.lat - dLat, n.lon + dLon); // SE corner
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.drawImage(plume, x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
      drawMarker(ctx, ...project(n.lat, n.lon));
    },
  });
}

// Mirrors REFERENCES.md part 1 — the citations a printed page can stand on.
const CITATIONS = [
  ["ISO 9613-2:1996 / ISO 9613-1:1993 — outdoor sound propagation & atmospheric absorption (stated accuracy ±3 dB)", ""],
  ["Directive 2002/49/EC (Environmental Noise Directive) — Lden/Lnight metrics", ""],
  ["WHO, Night Noise Guidelines for Europe (2009) — 40 dB Lnight guideline", "who.int/europe/publications/i/item/9789289041737"],
  ["Vendor sound data (Carrier/Trane/BAC/Caterpillar) & ASHRAE Applications ch. 49 — equipment sound powers (screening values)", ""],
  ["Stull (2011), J. Appl. Meteor. Climatol. 50:2267 — wet-bulb from T & RH (±0.3 °C)", "doi.org/10.1175/JAMC-D-11-0143.1"],
  ["SPX Cooling Technologies, Cooling Tower Fundamentals — evaporation & winter latent-fraction behaviour", ""],
  ["The Green Grid WP#35 (2011) — Water Usage Effectiveness (WUE) metric", ""],
  ["Macknick et al. (2012), Environ. Res. Lett. 7 045802 — water consumption per generation technology (tower medians)", "iopscience.iop.org/article/10.1088/1748-9326/7/4/045802"],
  ["Scherer & Pfister (2016); Bakken et al. (2017) — hydro reservoir evaporation, net vs gross, contested allocation", ""],
  ["Open-Meteo archive API — ERA5 hourly weather year", "open-meteo.com"],
  ["Eurostat sdg_06_60 (WEI+), env_wat_res (renewable freshwater), nrg_bal_peh (electricity by fuel)", "ec.europa.eu/eurostat"],
  ["EEA — WEI+ stress bands (>20 % stress, >40 % severe); water abstraction & household use statistics", "eea.europa.eu"],
  ["Validation against published facility data (Meta Talavera planning figures; Google/Microsoft/Meta fleet WUE; Uptime Institute 2024 PUE survey; LBNL 2024 US report) — see REFERENCES.md", ""],
];

const settingsRows = (pairs) => pairs.map(([k, v]) =>
  `<tr><td class="pr-k">${k}</td><td>${v}</td></tr>`).join("");

function template(n, w, links, maps) {
  const tech = TECHS.find((t) => t.key === facility.tech);
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const haTxt = w.ringHa >= 20 ? Math.round(w.ringHa).toLocaleString("en-GB") : w.ringHa.toFixed(1);
  return `
  <div class="pr-head">
    <div class="pr-kicker">DC LAB · SCREENING REPORT</div>
    <h1>${facility.mw} MW IT · ${tech.label} · ${w.countryName}</h1>
    <div class="pr-meta">Site ${facility.lat.toFixed(4)}°N, ${facility.lon.toFixed(4)}°E · generated ${today} ·
      screening-grade models, every assumption disclosed — not a certified assessment</div>
    ${maps.site ? `<figure class="pr-map"><img src="${maps.site}" alt="site context map">
      <figcaption>The selected site. Dashed ring: the year's total water draw as the irrigated
      farmland it could have watered instead (${haTxt} ha); filled ring: the evaporated
      (consumed) share.</figcaption></figure>` : ""}
  </div>

  <div class="pr-section">
    <h2>1 · Noise — how far the hum carries</h2>
    <div class="pr-cols">
      <div>
        <div class="pr-big">${n.lwa} <span>dB(A) total sound power</span></div>
        <div class="pr-sub">${n.mode}</div>
        <table class="pr-settings">${settingsRows(n.settings)}</table>
      </div>
      <div>
        <h3>${n.distTitle}</h3>
        <table class="nz-table">${n.distHTML}</table>
      </div>
    </div>
    <div class="pr-cols">
      <figure><img src="${maps.noise ?? n.plumeImg}" alt="noise plume on the map">
        <figcaption>LAeq field around the site (${(2 * n.plumeHalf / 1000).toFixed(1)} × ${(2 * n.plumeHalf / 1000).toFixed(1)} km),
        contours labelled in dB(A) — 45/55 emphasised, the common night/day limits.${maps.noise
          ? "" : " Basemap unavailable in this export — see the shared link below for the interactive map."}</figcaption></figure>
      <figure><img src="${n.spectrumImg}" alt="octave spectrum">
        <figcaption>${n.specTitle}. Low bands travel farthest — distant plant reads as a rumble.</figcaption></figure>
    </div>
    <h3>What's making the noise</h3>
    <table class="nz-table pr-half">${n.groupsHTML}</table>
    <p class="pr-method">Method: ISO 9613-2 octave-band propagation (ISO 9613-1 air absorption, per-band ground
      effect, barrier diffraction, §8 meteorology), A-weighted, ~15,000 receptors — ${n.meta}. Downwind
      (worst-case) levels; stated method accuracy ±3 dB; no terrain or building shielding.</p>
  </div>

  <div class="pr-section pr-break">
    <h2>2 · Water — how much it drinks, and who feels it</h2>
    <div class="pr-cols">
      <div>
        <div class="pr-big">${w.makeup} <span>of water per year</span></div>
        <div class="pr-sub">${w.splitHTML}</div>
        <div class="pr-minirow"><b>WUE ${w.wue}</b> L/kWh IT · <b>PUE ${w.pue}</b> · peak day <b>${w.peak}</b></div>
        <div class="pr-sub">${w.climateLine}</div>
        <table class="pr-settings">${settingsRows(w.settings)}</table>
      </div>
      <div>
        <h3>What that amount of water means</h3>
        <table class="nz-table">${w.perspHTML}</table>
        <h3>Where the water goes</h3>
        <table class="nz-table">${w.fateHTML}</table>
        <p class="pr-fine">${w.fateCap}</p>
      </div>
    </div>
    <div class="pr-cols">
      <figure><img src="${w.monthlyImg}" alt="monthly water profile">
        <figcaption>${w.monthlyCap}</figcaption></figure>
      <figure><img src="${w.compareImg}" alt="technology comparison">
        <figcaption>${w.compareCap}</figcaption></figure>
    </div>
  </div>

  <div class="pr-section">
    <h2>3 · Can the region afford it?</h2>
    <div class="pr-cols">
      <div>
        <div class="pr-big pr-wei">${w.wei}</div>
        <figure class="pr-spark"><img src="${w.weiImg}" alt="WEI+ trend">
          <figcaption>WEI+ trend, 2000 → latest (Eurostat sdg_06_60)</figcaption></figure>
        ${w.stressHTML}
      </div>
      <div>
        <h3>This facility's slice</h3>
        <p>${w.impactNatHTML}</p>
        <p>${w.impactLocHTML}</p>
        <p class="pr-fine">Both use national annual data; real stress is basin-level and seasonal —
          a permit needs the river-basin-district WEI+ and the utility's supply plan.</p>
      </div>
    </div>
  </div>

  <div class="pr-section pr-break">
    <h2>4 · Method, limits &amp; references</h2>
    <p class="pr-method">Both labs are <b>screening models</b> for siting, technology and disclosure debates —
      not certified assessments. Noise: vendor-typical source levels, flat terrain, no building shielding.
      Water: one real ERA5 weather year (hot years run thirstier), national WEI+ (basin/seasonal stress is
      sharper), drinking-quality mains assumed (reclaimed/sea water are strong mitigations). Cooling
      technology, site and IT capacity are one shared facility across both labs.</p>
    <ol class="pr-refs">${CITATIONS.map(([t, u]) =>
      `<li>${t}${u ? ` — <span class="pr-url">${u}</span>` : ""}</li>`).join("")}</ol>
    <p class="pr-fine">Reproduce interactively — Noise: <span class="pr-url">${links.noise}</span><br>
      Water: <span class="pr-url">${links.water}</span><br>
      Full audit trail: REFERENCES.md in the application folder.</p>
  </div>`;
}

let busy = false;

export async function exportReport() {
  if (busy) return;
  busy = true;
  const overlay = $("report-overlay");
  const prevHash = location.hash || "#noise";
  overlay.hidden = false;
  overlay.textContent = "Building the report — running both labs…";
  try {
    // Each lab must have computed with a real layout, and its payload must be
    // captured while its view is still visible — hiding a view collapses its
    // chart canvases to 0×0, which would blank the images.
    await showView("noise");
    await waitFor(getNoiseReport, 30000, "Noise Lab");
    await wait(300); // let the chart settle after the view switch
    const n = getNoiseReport();
    const noiseLink = location.href;

    await showView("water");
    await waitFor(getWaterReport, 90000, "Water Lab (fetching the weather year)");
    await wait(400);
    const w = getWaterReport();
    const waterLink = location.href;

    overlay.textContent = "Composing the site maps…";
    const [site, noiseMap] = await Promise.all([siteBanner(w), noisePlumeMap(n)]);

    $("print-report").innerHTML =
      template(n, w, { noise: noiseLink, water: waterLink }, { site, noise: noiseMap });

    // print() snapshots the frame immediately — the multi-hundred-KB map
    // images decode asynchronously and would come out blank unless we wait
    // for every image to be fully decoded first.
    overlay.textContent = "Finishing the document…";
    await Promise.all([...$("print-report").querySelectorAll("img")]
      .map((img) => img.decode().catch(() => {})));
    await wait(150);

    overlay.hidden = true;
    window.print();
  } catch (err) {
    overlay.textContent = `⚠ ${err.message} — close this by clicking anywhere`;
    await new Promise((r) => overlay.addEventListener("click", r, { once: true }));
    overlay.hidden = true;
  } finally {
    // restore whichever lab the user was in
    history.replaceState(null, "", prevHash);
    await showView(prevHash.slice(1).split("?")[0]);
    busy = false;
  }
}
