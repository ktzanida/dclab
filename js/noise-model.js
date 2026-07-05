// Noise Lab — the acoustics engine.
//
// A screening-grade implementation of outdoor industrial sound propagation,
// following the method of ISO 9613-2 ("Attenuation of sound during propagation
// outdoors — General method of calculation") in 8 octave bands (63 Hz – 8 kHz),
// with atmospheric absorption per ISO 9613-1 and A-weighting to human hearing.
//
// The chain, per source s, receiver r and octave band f:
//
//   Lp(s,r,f) = Lw(s,f) − Adiv(d) − Aatm(f,d) − Agr(f, geometry) − Abar(f, wall)
//
//   Adiv  geometric divergence: 20·log10(d) + 11   (spherical spreading, dB re 1 m)
//   Aatm  air absorption: α(f, T, RH)·d            (full ISO 9613-1 formula)
//   Agr   ground effect: ISO 9613-2 §7.3.1 per-band method (source / middle /
//         receiver regions, ground factor G: 0 = hard, 1 = porous)
//   Abar  barrier diffraction over a perimeter wall: Dz = 10·log10(3 + (20/λ)·z·Kmet),
//         z = path-length difference over the wall top, capped at 20 dB
//
// then A-weight each band, energy-sum bands and sources:
//
//   LAeq(r) = 10·log10 Σ_s Σ_f 10^((Lp(s,r,f) + AW(f)) / 10)
//
// ISO 9613-2 computes the *downwind* (worst-case) level — the level you get when
// the wind blows from the site toward you, in every direction at once. Real
// long-term averages are a few dB lower; stated accuracy of the method is ±3 dB.
//
// Everything here is deliberately dependency-free and synchronous: a full grid
// (~15k receptors × ~25 sources × 8 bands) computes in well under a second.

export const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

// IEC 61672 A-weighting at octave mid-bands: how much quieter (or louder) each
// band sounds to a human ear than a sound-level meter set to "flat".
export const A_WEIGHT = [-26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];

const LN10_10 = Math.LN10 / 10; // 10^(x/10) = exp(x·LN10_10)

// ------------------------------------------------------------ equipment catalog
//
// Per-unit A-weighted sound power levels (LwA, dB re 1 pW) and unweighted octave
// spectra are typical of published vendor data (Carrier / Trane / BAC / Caterpillar
// sound data sheets) and ASHRAE Applications ch. 49 ranges for this class of plant:
//
//   air-cooled chiller (screw, ~1.4 MW cooling)      LwA ≈ 96–102  → 99
//   dry cooler / free-cooling bank (per ~1 MW)       LwA ≈ 90–96   → 93
//   open cooling-tower cell (~2.2 MW)                LwA ≈ 94–100  → 97
//   rooftop AHU / exhaust fan set (per ~3 MW IT)     LwA ≈ 91–97   → 94
//   standby diesel genset, 2.5 MW, enclosed +
//     industrial-grade exhaust silencer              LwA ≈ 105–112 → 108
//   grid transformer (~40 MVA), tonal 100/125 Hz hum LwA ≈ 85–95   → 90
//
// `shape` is the unweighted octave spectrum relative to its loudest band; each
// unit's absolute band levels are normalized so the A-weighted total equals lwa.
// `eve` / `night` are duty-cycle level deltas (fan affinity laws: evening load
// tapering ≈ −1 dB, ~60 % night load ≈ −3 dB); `pkg` is the delta for a
// best-practice acoustic package (low-noise fans, VFDs, inlet/discharge
// attenuators, critical-grade genset silencers). `tonal` marks plant whose
// noise has audible tonal / impulsive character (transformer 100/125 Hz hum,
// genset firing rumble) — used for the rating-level penalty (see ratingLevel).

const CATALOG = {
  chiller: {
    label: "Air-cooled chillers", where: "roof",
    lwa: 99, shape: [-5, -3, -1, 0, -1, -3, -7, -13],
    perMW: 1 / 1.4, h: 13, eve: -1, night: -3, pkg: -8,
  },
  drycooler: {
    label: "Dry coolers (liquid loop)", where: "roof",
    lwa: 93, shape: [-4, -3, -2, 0, -2, -5, -9, -15],
    perMW: 1 / 1.0, h: 13, eve: -1, night: -3, pkg: -8,
  },
  tower: {
    label: "Cooling-tower cells", where: "east",
    lwa: 97, shape: [-2, -1, 0, -1, -2, -4, -8, -14],
    perMW: 1 / 2.2, h: 5, eve: -1, night: -3, pkg: -8,
  },
  ahu: {
    label: "Rooftop air handling / exhaust", where: "roof",
    lwa: 94, shape: [-6, -4, -2, 0, -2, -5, -9, -14],
    perMW: 1 / 3.0, h: 13, eve: -1, night: -2, pkg: -8,
  },
  evapahu: {
    // Direct-evaporative "penthouse" fan walls: acoustically an AHU, but the
    // whole cooling system — so roughly twice the air handling per MW and no
    // chillers at all.
    label: "Evaporative air-handling walls", where: "roof",
    lwa: 94, shape: [-6, -4, -2, 0, -2, -5, -9, -14],
    perMW: 1 / 1.5, h: 13, eve: -1, night: -2, pkg: -8,
  },
  genset: {
    label: "Standby gensets (on test)", where: "west",
    lwa: 108, shape: [2, 0, -2, -4, -5, -7, -11, -16],
    perMW: 1.1 / 2.5, h: 3, eve: 0, night: 0, pkg: -10, tonal: true,
  },
  transformer: {
    label: "Grid transformers", where: "south",
    lwa: 90, shape: [-2, 6, 0, -4, -10, -16, -22, -28],
    perMW: 1 / 40, minCount: 1, h: 2.5, eve: 0, night: 0, pkg: -4, tonal: true,
  },
};

export const SOURCE_KINDS = Object.entries(CATALOG).map(([kind, c]) => ({
  kind, label: c.label, defaultLwa: c.lwa,
}));

// One entry per shared cooling technology (see water-model.js TECHS).
// Acoustic mapping: adiabatic pre-cooling pads are silent, so "adiabatic"
// sounds like plain air-cooled chillers; direct-evaporative fresh-air is
// fan walls only.
const COOLING_SETS = {
  air: ["chiller", "ahu"],
  towers: ["tower", "ahu"],
  liquid: ["drycooler", "ahu"],
  adiabatic: ["chiller", "ahu"],
  evapair: ["evapahu"],
};

// Normalize a relative unweighted spectrum so its A-weighted energy sum = lwa.
function bandLw(shape, lwa) {
  let e = 0;
  for (let i = 0; i < 8; i++) e += Math.exp((shape[i] + A_WEIGHT[i]) * LN10_10);
  const offset = lwa - 10 * Math.log10(e);
  return shape.map((s) => s + offset);
}

// Spread `count` identical units over at most `maxPts` point sources placed by
// `posFn(i, nPts)`; each point carries n·Lw_unit. Energy is conserved exactly.
function clusterSources(count, maxPts, posFn, h, lw, group, tonal) {
  const nPts = Math.min(count, maxPts);
  const out = [];
  for (let i = 0; i < nPts; i++) {
    const units = Math.floor(count / nPts) + (i < count % nPts ? 1 : 0);
    const [x, y] = posFn(i, nPts);
    out.push({ x, y, h, group, units, tonal, lw: lw.map((v) => v + 10 * Math.log10(units)) });
  }
  return out;
}

// Lden combination (Directive 2002/49/EC): 12 h day, 4 h evening (+5 dB
// weighting), 8 h night (+10 dB). Applied at the *source* level: propagation
// attenuation is level-independent, so propagating the Lden-combined sound
// power is exactly equivalent to combining three propagated period fields.
export function ldenCombine(day, eve, night) {
  return 10 * Math.log10((
    12 * Math.pow(10, day / 10) +
    4 * Math.pow(10, (eve + 5) / 10) +
    8 * Math.pow(10, (night + 10) / 10)
  ) / 24);
}

// ------------------------------------------------------------ scenario builder
//
// Layout model: a square building of side L (≈ 700 m² of building per MW of IT
// load — hyperscale-typical), north-aligned. Chillers / dry coolers / AHUs sit on
// the roof; cooling towers in a yard off the east façade; gensets in a compound
// off the west façade; transformers by the south wall. A perimeter wall (optional)
// runs 30 m outside the building line on all sides.
//
// params: {
//   mw, cooling: "air"|"towers"|"liquid", gensetTest, pkg,
//   metric: "day" | "night" | "den",
//   overrides: { [kind]: { lwa?, count? } }   — user-edited source data
// }
//
// Metric handling: "day" is full load (plus gensets if a test is running);
// "night" applies the part-load deltas and drops gensets (tests are a daytime
// event); "den" combines the three duty periods per Lden at source level.
// A monthly 1–2 h genset test annualizes to ≈ −27 dB on its Lw — negligible in
// Lden, so gensets are excluded there too (shown in the "day" view instead).

export function buildScenario(p) {
  const L = Math.min(600, Math.max(60, Math.sqrt(p.mw * 700)));
  const wallDist = L / 2 + 30;
  const metric = p.metric ?? "day";

  const kinds = [...COOLING_SETS[p.cooling] ?? COOLING_SETS.air, "transformer"];
  if (p.gensetTest && metric === "day") kinds.push("genset");

  const sources = [];
  const groups = [];

  for (const kind of kinds) {
    const c = CATALOG[kind];
    const ov = p.overrides?.[kind] ?? {};
    const count = ov.count ?? Math.max(c.minCount ?? 1, Math.ceil(p.mw * c.perMW));
    if (count <= 0) continue;
    let base = ov.lwa ?? c.lwa;
    if (p.pkg) base += c.pkg;
    const lwa = metric === "night" ? base + c.night
      : metric === "den" ? ldenCombine(base, base + c.eve, base + c.night)
      : base;
    const lw = bandLw(c.shape, lwa);

    const inset = L * 0.32, edge = L / 2 + 15;
    const posFns = {
      roof: (i, n) => { // grid across the roof
        const cols = Math.ceil(Math.sqrt(n));
        const cx = i % cols, cy = Math.floor(i / cols);
        const rows = Math.ceil(n / cols);
        return [
          cols === 1 ? 0 : -inset + (2 * inset * cx) / (cols - 1),
          rows === 1 ? 0 : -inset + (2 * inset * cy) / (rows - 1),
        ];
      },
      east: (i, n) => [edge, n === 1 ? 0 : -inset + (2 * inset * i) / (n - 1)],
      west: (i, n) => [-edge, n === 1 ? 0 : -inset + (2 * inset * i) / (n - 1)],
      south: (i, n) => [n === 1 ? 0 : -inset + (2 * inset * i) / (n - 1), -edge],
    };
    const maxPts = { roof: 9, east: 6, west: 8, south: 2 }[c.where];
    sources.push(...clusterSources(count, maxPts, posFns[c.where], c.h, lw, kind, !!c.tonal));

    groups.push({
      kind, label: c.label, count, unitLwa: lwa, tonal: !!c.tonal,
      groupLwa: lwa + 10 * Math.log10(count),
    });
  }

  let e = 0;
  for (const g of groups) e += Math.exp(g.groupLwa * LN10_10);
  const totalLwa = 10 * Math.log10(e);

  return { sources, groups, totalLwa, side: L, wallDist };
}

// -------------------------------------------------- ISO 9613-1 air absorption
//
// Pure-tone atmospheric attenuation coefficient α [dB/m] at frequency f [Hz],
// temperature T [°C], relative humidity hr [%], ambient pressure 101.325 kPa.
// This is the complete standard formula (oxygen + nitrogen relaxation), not a
// lookup table — high frequencies die off fast in cold dry air, which is why a
// distant plant sounds like a low rumble.

export function airAbsorption(tempC, rh) {
  const T = 273.15 + tempC, T0 = 293.15, T01 = 273.16;
  const psat = Math.pow(10, -6.8346 * Math.pow(T01 / T, 1.261) + 4.6151);
  const h = rh * psat; // molar concentration of water vapour, %
  const frO = 24 + 4.04e4 * h * (0.02 + h) / (0.391 + h);
  const frN = Math.pow(T / T0, -0.5) *
    (9 + 280 * h * Math.exp(-4.17 * (Math.pow(T / T0, -1 / 3) - 1)));
  return BANDS.map((f) => {
    const f2 = f * f;
    return 8.686 * f2 * (
      1.84e-11 * Math.sqrt(T / T0) +
      Math.pow(T / T0, -2.5) * (
        0.01275 * Math.exp(-2239.1 / T) * frO / (frO * frO + f2) +
        0.1068 * Math.exp(-3352 / T) * frN / (frN * frN + f2)
      )
    );
  });
}

// ------------------------------------------------ ISO 9613-2 §7.3.1 ground effect
//
// Per-band ground attenuation split into source region (30·hs, ground factor Gs),
// middle region (Gm) and receiver region (30·hr, Gr). The site itself is paved,
// so Gs = 0; Gm = Gr = G chosen by the user (0 hard urban … 1 soft grassland).
// Negative values (ground-reflection amplification over hard ground) are floored
// at −3 dB total — the conservative-realistic end of the standard's range.

function gndFns(h, dp) {
  const k = 1 - Math.exp(-dp / 50);
  return [
    1.5 + 3.0 * Math.exp(-0.12 * (h - 5) ** 2) * k +
      5.7 * Math.exp(-0.09 * h * h) * (1 - Math.exp(-2.8e-6 * dp * dp)), // a′ (125 Hz)
    1.5 + 8.6 * Math.exp(-0.09 * h * h) * k,  // b′ (250 Hz)
    1.5 + 14.0 * Math.exp(-0.46 * h * h) * k, // c′ (500 Hz)
    1.5 + 5.0 * Math.exp(-0.9 * h * h) * k,   // d′ (1 kHz)
  ];
}

function groundAtten(out, hs, hr, dp, Gs, Gm, Gr) {
  const q = dp <= 30 * (hs + hr) ? 0 : 1 - (30 * (hs + hr)) / dp;
  const s = gndFns(hs, dp), r = gndFns(hr, dp);
  for (let b = 0; b < 8; b++) {
    let As, Ar, Am;
    if (b === 0) { As = -1.5; Ar = -1.5; Am = -3 * q; }
    else if (b >= 1 && b <= 4) {
      As = -1.5 + Gs * s[b - 1];
      Ar = -1.5 + Gr * r[b - 1];
      Am = -3 * q * (1 - Gm);
    } else {
      As = -1.5 * (1 - Gs);
      Ar = -1.5 * (1 - Gr);
      Am = -3 * q * (1 - Gm);
    }
    out[b] = Math.max(-3, As + Am + Ar);
  }
}

// --------------------------------------------------- barrier (perimeter wall)
//
// Single diffraction over the top edge of a wall of height hb enclosing the site.
// Path-length difference z over the wall top vs the direct path; ISO 9613-2 §7.4:
//   Dz = 10·log10(3 + (C2/λ)·z·Kmet),  C2 = 20 (ground reflections included),
//   Kmet = exp(−(1/2000)·√(d1·d2·d / (2z)))  (meteorological curvature), cap 20 dB.
// The wall replaces (never stacks with) the ground effect for that path — using
// whichever attenuates more, a standard engineering treatment of the interplay.
// Line-of-sight is checked in 3-D, so tall roof sources correctly see over it.

function barrierAtten(out, sx, sy, hs, rx, ry, hr, S, hb) {
  const dx = rx - sx, dy = ry - sy;
  const dp = Math.hypot(dx, dy);
  if (dp < 1e-6) { out.fill(0); return; }
  // ray → enclosing square |x| = S, |y| = S: first positive crossing
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (S - sx) / dx);
  if (dx < -1e-9) t = Math.min(t, (-S - sx) / dx);
  if (dy > 1e-9) t = Math.min(t, (S - sy) / dy);
  if (dy < -1e-9) t = Math.min(t, (-S - sy) / dy);
  const d1 = t * dp; // source → wall (horizontal)
  if (!isFinite(t) || d1 >= dp) { out.fill(0); return; } // receiver inside wall
  const d2 = dp - d1;
  const hlos = hs + ((hr - hs) * d1) / dp; // sight-line height at the wall
  if (hb <= hlos) { out.fill(0); return; }
  const d = Math.sqrt(dp * dp + (hr - hs) ** 2);
  const z = Math.hypot(d1, hb - hs) + Math.hypot(d2, hb - hr) - d;
  if (z <= 0) { out.fill(0); return; }
  const kmet = Math.exp(-Math.sqrt((d1 * d2 * d) / (2 * z)) / 2000);
  for (let b = 0; b < 8; b++) {
    const lambda = 343 / BANDS[b];
    out[b] = Math.min(20, 10 * Math.log10(3 + (20 / lambda) * z * kmet));
  }
}

// -------------------------------------------- ISO 9613-2 §8 long-term meteorology
//
// The core method gives the downwind (moderately favourable) level. For a
// *long-term average*, the standard subtracts Cmet = C0·[1 − 10(hs+hr)/dp]
// (zero below dp = 10(hs+hr)); C0 depends on how often propagation is actually
// downwind at that bearing. We make C0 directional around the prevailing wind:
// receptors downwind of the site keep C0 ≈ 0 (often favourable), receptors
// upwind get the full C0max (rarely favourable). C0max ≈ 3 dB is typical of
// mid-European wind statistics (the standard bounds C0 at ~5 dB).
//
// env.c0max = 0 reproduces the pure downwind worst case.
// env.windTo = math-convention angle (radians) sound is carried TOWARD.

function cmet(env, hs, dx, dy, dp) {
  if (!(env.c0max > 0)) return 0;
  const lim = (10 * (hs + env.hr)) / dp;
  if (lim >= 1) return 0;
  const c0 = env.c0max * (1 - Math.cos(Math.atan2(dy, dx) - env.windTo)) / 2;
  return c0 * (1 - lim);
}

// Rating level (BS 4142 / TA Lärm-style character correction, simplified):
// where plant with tonal/impulsive character (transformer hum, genset firing)
// contributes within 6 dB of the total — i.e. its character is audible — the
// assessment level takes a +5 dB penalty. Real schemes grade the penalty by
// audibility; this single-step version is the common screening treatment.
export function ratingLevel(laeq, tonalDb) {
  return tonalDb > laeq - 6 ? laeq + 5 : laeq;
}

// --------------------------------------------------------------- point receiver
//
// env: { alpha: dB/m per band, G: ground factor, wallH: m (0 = none), S: wall
// half-extent m, hr: receiver height m, c0max: dB, windTo: rad }.
// (x, y) in metres from facility center.

const _agr = new Float64Array(8);
const _abar = new Float64Array(8);

export function levelAt(scenario, env, x, y) {
  const bands = new Float64Array(8);
  const wall = env.wallH > 0;
  let eTotal = 0, eTonal = 0;
  for (const s of scenario.sources) {
    const ddx = x - s.x, ddy = y - s.y;
    const dp = Math.max(3, Math.hypot(ddx, ddy));
    const dz = s.h - env.hr;
    const d = Math.sqrt(dp * dp + dz * dz);
    const adiv = 20 * Math.log10(d) + 11;
    const met = cmet(env, s.h, ddx, ddy, dp);
    groundAtten(_agr, s.h, env.hr, dp, 0, env.G, env.G);
    if (wall) barrierAtten(_abar, s.x, s.y, s.h, x, y, env.hr, env.S, env.wallH);
    for (let b = 0; b < 8; b++) {
      const excess = wall && _abar[b] > _agr[b] ? _abar[b] : _agr[b]; // wall replaces ground
      const lp = s.lw[b] - adiv - env.alpha[b] * d - excess - met;
      const e = Math.exp((lp + A_WEIGHT[b]) * LN10_10);
      bands[b] += e;
      eTotal += e;
      if (s.tonal) eTonal += e;
    }
  }
  return {
    laeq: 10 * Math.log10(Math.max(eTotal, 1e-12)),
    tonalDb: 10 * Math.log10(Math.max(eTonal, 1e-12)),
    bands: Array.from(bands, (e) => 10 * Math.log10(Math.max(e, 1e-12))),
  };
}

// ------------------------------------------------------------------ field grid
//
// n × n receptors over [−half, +half]² metres. Returns { laeq, tonal }, both
// Float32Array in dB — `tonal` is the contribution of character-marked plant,
// so the caller can form rating levels per receptor (ratingLevel).
// Same math as levelAt, restructured source-outer for cache friendliness.

export function computeGrid(scenario, env, half, n) {
  const eAll = new Float64Array(n * n);   // accumulate linear energy
  const eTon = new Float64Array(n * n);
  const step = (2 * half) / (n - 1);
  const hr = env.hr, G = env.G, wall = env.wallH > 0;

  for (const s of scenario.sources) {
    // precompute exp(lw + AW) once per source band
    const srcE = s.lw.map((lw, b) => Math.exp((lw + A_WEIGHT[b]) * LN10_10));
    for (let j = 0; j < n; j++) {
      const y = -half + j * step;
      const rowOff = j * n;
      for (let i = 0; i < n; i++) {
        const x = -half + i * step;
        const ddx = x - s.x, ddy = y - s.y;
        const dp = Math.max(3, Math.hypot(ddx, ddy));
        const dz = s.h - hr;
        const d = Math.sqrt(dp * dp + dz * dz);
        const met = cmet(env, s.h, ddx, ddy, dp);
        const spread = Math.exp(-(20 * Math.log10(d) + 11 + met) * LN10_10);
        groundAtten(_agr, s.h, hr, dp, 0, G, G);
        if (wall) barrierAtten(_abar, s.x, s.y, s.h, x, y, hr, env.S, env.wallH);
        let e = 0;
        for (let b = 0; b < 8; b++) {
          const excess = wall && _abar[b] > _agr[b] ? _abar[b] : _agr[b];
          e += srcE[b] * spread * Math.exp(-(env.alpha[b] * d + excess) * LN10_10);
        }
        eAll[rowOff + i] += e;
        if (s.tonal) eTon[rowOff + i] += e;
      }
    }
  }
  const laeq = new Float32Array(n * n);
  const tonal = new Float32Array(n * n);
  for (let k = 0; k < laeq.length; k++) {
    laeq[k] = 10 * Math.log10(Math.max(eAll[k], 1e-12));
    tonal[k] = 10 * Math.log10(Math.max(eTon[k], 1e-12));
  }
  return { laeq, tonal };
}

// How far out to compute: march until `evalFn(x, y) → dB` drops below floorDb.
// evalFn is whatever field is being displayed (plain LAeq or rating level).
export function suggestExtent(evalFn, floorDb = 30) {
  let r = 150;
  while (r < 25000 && evalFn(r, 0) > floorDb) r *= 1.25;
  return Math.max(500, Math.min(25000, r * 1.1));
}

// Outermost distance at which the field still reaches `db`: max over 16 compass
// directions of the last outward crossing (exact model, not the grid).
export function distanceTo(evalFn, innerR, db, maxR) {
  let best = 0;
  for (let k = 0; k < 16; k++) {
    const ux = Math.cos((k * Math.PI) / 8), uy = Math.sin((k * Math.PI) / 8);
    let lo = innerR, hi = maxR;
    if (evalFn(ux * hi, uy * hi) >= db) { best = Math.max(best, hi); continue; }
    if (evalFn(ux * lo, uy * lo) < db) continue;
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2;
      if (evalFn(ux * mid, uy * mid) >= db) lo = mid; else hi = mid;
    }
    best = Math.max(best, lo);
  }
  return best;
}
