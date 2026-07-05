// The data layer — everything the labs need, fetched by the visitor's own
// browser. No backend, no keys, no secrets:
//
//   climate   Open-Meteo archive API (ERA5 reanalysis): 8,760+ hours of
//             dry-bulb temperature and relative humidity for the exact site,
//             for one complete recent weather year. CORS-enabled and free —
//             each visitor's calls count against their own IP, so a static
//             deployment scales by itself.
//
//   stress    Eurostat sdg_06_60 — the Water Exploitation Index plus (WEI+):
//             water consumption as % of renewable freshwater resources, the
//             EU's headline scarcity indicator (EEA bands: >20 % stress,
//             >40 % severe). Fetched live from Eurostat's CORS-open API.
//
//   grid mix  Eurostat nrg_bal_peh — gross electricity production by fuel —
//             weighted by operational water-consumption factors per
//             technology (medians from Macknick et al. 2012, ERL 7 045802,
//             recirculating cooling; hydro reservoir evaporation kept
//             separate because its allocation is genuinely contested).
//             This prices the *upstream* water in the site's electricity.
//
//   geometry  data/europe.geojson — GISCO 1:20m country polygons, bundled
//             (static, ~0.3 MB; regenerate with tools/build_geo.py).
//
// All fetches are memoized for the session; Eurostat/Open-Meteo responses are
// also good HTTP-cache citizens.

// The most recent COMPLETE calendar year — the simulation's weather year.
export const WEATHER_YEAR = new Date().getUTCFullYear() - 1;

const EUROSTAT = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
const OPEN_METEO = "https://archive-api.open-meteo.com/v1/archive";

const memo = new Map();
function once(key, fn) {
  if (!memo.has(key)) {
    memo.set(key, fn().catch((err) => { memo.delete(key); throw err; }));
  }
  return memo.get(key);
}

async function getJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} — ${url.split("?")[0]}`);
  return resp.json();
}

// ------------------------------------------------------------------- climate

async function fetchClimate(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon,
    start_date: `${WEATHER_YEAR}-01-01`, end_date: `${WEATHER_YEAR}-12-31`,
    hourly: "temperature_2m,relative_humidity_2m", timezone: "UTC",
  });
  const js = await getJSON(`${OPEN_METEO}?${q}`);
  const time = js.hourly?.time ?? [];
  const t = js.hourly?.temperature_2m ?? [];
  const rh = js.hourly?.relative_humidity_2m ?? [];
  if (time.length < 8760) throw new Error(`incomplete weather year (${time.length} hours)`);

  const months = new Array(time.length);
  const t2m = new Array(time.length);
  const rhArr = new Array(time.length);
  for (let i = 0; i < time.length; i++) {
    months[i] = +time[i].slice(5, 7);
    // ERA5 is gap-free in practice; carry the previous hour over any null
    t2m[i] = t[i] ?? t2m[i - 1] ?? 10;
    rhArr[i] = rh[i] ?? rhArr[i - 1] ?? 70;
  }
  return {
    lat, lon,
    elevation: js.elevation,
    year: WEATHER_YEAR,
    source: "ERA5 reanalysis · Open-Meteo",
    months, t2m, rh: rhArr,
  };
}

// -------------------------------------------------- Eurostat JSON-stat 2.0

// Flatten a JSON-stat 2.0 dataset into records keyed by dimension codes.
function parseJsonStat(js) {
  const ids = js.id, sizes = js.size, dims = js.dimension;
  const axes = ids.map((dim) => {
    const index = dims[dim].category.index;
    if (Array.isArray(index)) return index;
    const codes = new Array(Object.keys(index).length);
    for (const [code, i] of Object.entries(index)) codes[i] = code;
    return codes;
  });
  const records = [];
  for (const [flat, value] of Object.entries(js.value ?? {})) {
    let rest = +flat;
    const coords = new Array(sizes.length);
    for (let d = sizes.length - 1; d >= 0; d--) {
      coords[d] = rest % sizes[d];
      rest = Math.floor(rest / sizes[d]);
    }
    const rec = { value };
    for (let d = 0; d < ids.length; d++) rec[ids[d]] = axes[d][coords[d]];
    records.push(rec);
  }
  return records;
}

// --------------------------------------------------------------- WEI+ stress

function weiAll() {
  return once("wei", async () => {
    const js = await getJSON(
      `${EUROSTAT}/sdg_06_60?format=JSON&lang=EN&statinfo=VAL_A`);
    const byGeo = {};
    for (const rec of parseJsonStat(js)) {
      if (rec.value == null) continue;
      (byGeo[rec.geo] ??= {})[rec.time] = rec.value;
    }
    return byGeo;
  });
}

function latest(series) {
  const years = Object.keys(series ?? {});
  if (!years.length) return null;
  const year = years.reduce((a, b) => (a > b ? a : b));
  return { year: +year, value: series[year] };
}

// ------------------------------------------- renewable freshwater volumes
//
// env_wat_res RFW_RES: renewable freshwater resources in million m³ — the
// denominator behind WEI+, needed to express a facility's consumption as a
// change to the national index. A few countries don't report to Eurostat;
// for those we carry FAO AQUASTAT long-term annual averages so the
// "national impact" line never silently disappears.

const RESOURCES_FALLBACK = { // Mm³/yr, FAO AQUASTAT long-term annual averages
  EL: 68400, IT: 191300, AT: 77700, DK: 6000, LU: 3500,
};

function resourcesAll() {
  return once("rfw", async () => {
    const js = await getJSON(
      `${EUROSTAT}/env_wat_res?format=JSON&lang=EN&wat_proc=RFW_RES` +
      `&unit=MIO_M3&sinceTimePeriod=2010`);
    const out = {};
    for (const rec of parseJsonStat(js)) {
      if (rec.value == null) continue;
      if (!out[rec.geo] || rec.time > out[rec.geo].year) {
        out[rec.geo] = { year: rec.time, mio_m3: rec.value };
      }
    }
    return out;
  });
}

function resourcesFor(country, all) {
  const r = all[country];
  if (r) return { mio_m3: r.mio_m3, year: +r.year, source: `Eurostat env_wat_res, ${r.year}` };
  if (RESOURCES_FALLBACK[country]) {
    return { mio_m3: RESOURCES_FALLBACK[country], year: null,
      source: "FAO AQUASTAT long-term annual average" };
  }
  return null;
}

// ------------------------------- power mix → L of water per kWh of electricity
//
// Operational water *consumption* (not withdrawal) per kWh generated —
// thermoelectric medians for recirculating (tower) cooling, the dominant and
// conservative-for-consumption configuration.

// Medians from Macknick et al. 2012, table 2 (recirculating/tower cooling),
// converted gal/MWh → L/kWh: coal 687 → 2.60, NGCC 205 → 0.78, nuclear
// 672 → 2.54, biopower steam 553 → 2.09, CSP trough 906 → 3.43, PV 1 → ~0.01
// (panel washing), wind 0, geothermal flash+tower 15 → 0.06. Oil steam has no
// Macknick median — assumed coal-like steam cycle. Full sources: REFERENCES.md.
const WATER_FACTORS = {
  coal: [2.6, "Coal, lignite, peat & derived gases"],
  gas: [0.78, "Natural gas (mostly combined-cycle)"],
  oil: [1.6, "Oil"],
  nuclear: [2.54, "Nuclear"],
  bio: [2.1, "Bioenergy"],
  waste: [2.1, "Non-renewable waste"],
  geothermal: [0.06, "Geothermal"],
  csp: [3.4, "Solar thermal (CSP)"],
  solar: [0.01, "Solar PV"],
  wind: [0.005, "Wind"],
  other: [1.0, "Other / unclassified"],
};
// Hydro reservoir evaporation: Macknick's US gross median is 17 L/kWh and net
// estimates run ~40 % lower (Scherer & Pfister 2016); allocation of
// multi-purpose reservoirs is genuinely contested. 5 L/kWh is a deliberately
// conservative low-mid value for cooler European climates — and a UI toggle.
const HYDRO_FACTOR = 5.0;

// Eurostat SIEC aggregates → factor buckets (covering TOTAL exactly once;
// pumped-storage output RA130 is recycled electricity and excluded from both
// hydro and the denominator).
const SIEC_BUCKETS = [
  ["C0000X0350-0370", "coal"],
  ["C0350-0370", "coal"], // coke-oven / blast-furnace gas
  ["P1000", "coal"],      // peat
  ["S2000", "coal"],      // oil shale
  ["G3000", "gas"],
  ["O4000XBIO", "oil"],
  ["N900H", "nuclear"],
  ["RA200", "geothermal"],
  ["RA300", "wind"],
  ["RA410", "csp"],
  ["RA420", "solar"],
  ["BIOE", "bio"],
  ["W6100_6220", "waste"],
];

async function fetchGridMix(country) {
  const js = await getJSON(
    `${EUROSTAT}/nrg_bal_peh?format=JSON&lang=EN&unit=GWH&nrg_bal=GEP` +
    `&geo=${country}&sinceTimePeriod=2019`);
  const byYear = {};
  for (const rec of parseJsonStat(js)) {
    if (rec.value != null) (byYear[rec.time] ??= {})[rec.siec] = rec.value;
  }
  const year = Object.keys(byYear).filter((y) => byYear[y].TOTAL)
    .reduce((a, b) => (a > b ? a : b), "");
  if (!year) throw new Error(`no electricity production data for ${country}`);
  const data = byYear[year];

  const pumped = data.RA130 ?? 0;
  const total = data.TOTAL - pumped;
  const gwh = { hydro: Math.max(0, (data.RA100 ?? 0) - pumped) };
  for (const [siec, bucket] of SIEC_BUCKETS) {
    gwh[bucket] = (gwh[bucket] ?? 0) + (data[siec] ?? 0);
  }
  gwh.other = Math.max(0, total - Object.values(gwh).reduce((a, b) => a + b, 0));

  const mix = [];
  let intensity = 0; // L/kWh, hydro reservoir evaporation excluded
  let hydroL = 0;    // the hydro add-on, reported separately
  for (const [bucket, val] of Object.entries(gwh).sort((a, b) => b[1] - a[1])) {
    if (val <= 0) continue;
    const share = val / total;
    let factor, label;
    if (bucket === "hydro") {
      factor = HYDRO_FACTOR; label = "Hydro (reservoir evaporation)";
      hydroL = share * factor;
    } else {
      [factor, label] = WATER_FACTORS[bucket];
      intensity += share * factor;
    }
    mix.push({ bucket, label, gwh: Math.round(val), share, l_per_kwh: factor });
  }
  return {
    year: +year,
    total_gwh: Math.round(total),
    mix,
    intensity_l_per_kwh: +intensity.toFixed(3),
    intensity_incl_hydro_l_per_kwh: +(intensity + hydroL).toFixed(3),
  };
}

// ------------------------------------------------------------------- exports

export const data = {
  geo: () => once("geo", () => getJSON("data/europe.geojson")),

  climate: (lat, lon) =>
    once(`climate:${(+lat).toFixed(2)}:${(+lon).toFixed(2)}`,
      () => fetchClimate((+lat).toFixed(2), (+lon).toFixed(2))),

  // Latest WEI+ per country, for the map choropleth.
  weiMap: () => once("weiMap", async () => {
    const byGeo = await weiAll();
    const countries = {};
    for (const [geo, series] of Object.entries(byGeo)) {
      if (geo.length === 2) countries[geo] = latest(series);
    }
    return { countries };
  }),

  // Country water context: WEI+ series, renewable-resource volume, power mix.
  context: (country) => once(`context:${country}`, async () => {
    const [byGeo, resAll] = await Promise.all([
      weiAll().catch(() => ({})),
      resourcesAll().catch(() => ({})),
    ]);
    let grid = null;
    try {
      grid = await fetchGridMix(country);
    } catch { /* mix is enriching, not essential — the view degrades politely */ }
    return {
      country,
      wei: {
        series: byGeo[country] ?? {},
        latest: latest(byGeo[country]),
        eu_latest: latest(byGeo.EU27_2020),
        resources: resourcesFor(country, resAll),
      },
      grid,
    };
  }),
};
