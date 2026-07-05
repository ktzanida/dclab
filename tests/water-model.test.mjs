// Validation suite for the Water Lab thermodynamics engine
// (static/js/water-model.js).
//
// Physics checks, not UI tests: reference values (Stull wet-bulb, latent-heat
// bookkeeping), internal consistency (blowdown/CoC identity, monthly sums =
// annual totals), and behavioral invariants any cooling-water model must
// satisfy (hotter → thirstier, higher CoC → less makeup, dry techs stay dry,
// WUE/PUE land inside the published envelope for each technology).
//
// Run with:  npm test   (or: node --test tests/)

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS, LATENT_L_PER_KWH, TECHS, compareTechs, latentFraction,
  perspective, simulate, upstreamM3, weiBand, wetBulb,
} from "../js/water-model.js";

// Synthetic climates: constant conditions make hand-checks possible.
function constantClimate(t, rh) {
  const n = 8760;
  const months = new Array(n), t2m = new Array(n).fill(t), rhArr = new Array(n).fill(rh);
  for (let i = 0; i < n; i++) months[i] = Math.min(12, 1 + Math.floor(i / 730));
  return { months, t2m, rh: rhArr };
}

// A cartoon European year: cold winter, warm summer, sinusoidal days.
function seasonalClimate(tMean = 10, tSwing = 9) {
  const n = 8760;
  const months = new Array(n), t2m = new Array(n), rh = new Array(n);
  for (let i = 0; i < n; i++) {
    const day = i / 24;
    months[i] = Math.min(12, 1 + Math.floor(i / 730));
    const seasonal = -Math.cos((2 * Math.PI * day) / 365) * tSwing;
    const diurnal = -Math.cos((2 * Math.PI * (i % 24)) / 24) * 4;
    t2m[i] = tMean + seasonal + diurnal;
    rh[i] = 85 - seasonal * 1.5 - diurnal * 2; // drier when hotter, like real air
  }
  return { months, t2m, rh };
}

const P = { tech: "towers", mwIT: 60, util: 0.8 };

// ------------------------------------------------------------------- wet bulb

test("Stull wet-bulb matches published reference values", () => {
  // Stull (2011) worked example: T = 20 °C, RH = 50 % → Tw ≈ 13.7 °C
  assert.ok(Math.abs(wetBulb(20, 50) - 13.7) < 0.4, `${wetBulb(20, 50)}`);
  // saturated air: wet bulb ≈ dry bulb
  assert.ok(Math.abs(wetBulb(25, 99) - 25) < 0.6);
  // wet bulb never exceeds dry bulb, and drier air → colder wet bulb
  for (const t of [-5, 5, 15, 25, 35]) {
    let prev = t + 1e-9;
    for (const rh of [95, 70, 45, 20]) {
      const tw = wetBulb(t, rh);
      assert.ok(tw <= t + 1e-9, `Tw>${t} at RH ${rh}`);
      assert.ok(tw < prev, `not monotone at T=${t}, RH=${rh}`);
      prev = tw;
    }
  }
});

// -------------------------------------------------------- latent bookkeeping

test("evaporating all rejected heat costs 1.481 L/kWh — the physical anchor", () => {
  assert.ok(Math.abs(LATENT_L_PER_KWH - 3600 / 2430) < 0.01);
  // latent fraction is bounded and grows with temperature
  assert.ok(latentFraction(-10) >= 0.55 && latentFraction(40) <= 0.98);
  assert.ok(latentFraction(30) > latentFraction(5));
});

test("tower water balance: makeup = evap + blowdown, blowdown = evap/(CoC−1)", () => {
  const clim = constantClimate(28, 60); // hot: towers fully mechanical
  for (const coc of [3, 4, 6]) {
    const s = simulate(clim, { ...P, coc });
    // strip the non-cooling base water (0.02 L/kWh × IT energy) from makeup
    const base = 0.02 * s.itMWh;
    const cooling = s.makeupM3 - base;
    assert.ok(Math.abs(cooling - s.evapM3 * (1 + 1 / (coc - 1))) / cooling < 1e-9,
      `CoC ${coc}`);
    assert.ok(Math.abs(s.makeupM3 - s.evapM3 - s.blowdownM3) < 1e-6);
  }
  // higher cycles of concentration → strictly less makeup
  const m3 = simulate(clim, { ...P, coc: 3 }).makeupM3;
  const m6 = simulate(clim, { ...P, coc: 6 }).makeupM3;
  assert.ok(m6 < m3);
});

test("hand-check: constant hot hour reproduces the closed-form tower number", () => {
  // At 30 °C / 45 % RH: Twb ≈ 21 °C → fully mechanical (ramp ends at 14 °C).
  const clim = constantClimate(30, 45);
  const s = simulate(clim, { ...P, coc: 4 });
  const twb = wetBulb(30, 45);
  const cop = Math.min(9.5, Math.max(4.0, 9.5 - 0.16 * twb));
  const qRej = 1 + 1 / cop;
  const evapPerKWh = qRej * Math.min(0.98, 0.62 + 0.011 * 30) * LATENT_L_PER_KWH;
  const expectEvap = evapPerKWh * s.itMWh; // L/kWh × MWh_IT = m³
  assert.ok(Math.abs(s.evapM3 - expectEvap) / expectEvap < 1e-9);
});

// ------------------------------------------------------------------ invariants

test("dry technologies use zero site water in any climate", () => {
  for (const clim of [constantClimate(35, 30), seasonalClimate()]) {
    for (const tech of ["air", "liquid"]) {
      const s = simulate(clim, { ...P, tech });
      assert.ok(Math.abs(s.evapM3) < 1e-9, tech);
      // only the disclosed non-cooling base remains
      assert.ok(Math.abs(s.makeupM3 - 0.02 * s.itMWh) < 1e-6, tech);
    }
  }
});

test("hotter climates are thirstier and less efficient, for every wet tech", () => {
  const cool = seasonalClimate(8, 8);   // Stockholm-ish
  const hot = seasonalClimate(17, 10);  // Madrid-ish
  for (const tech of ["towers", "adiabatic", "evapair"]) {
    const a = simulate(cool, { ...P, tech });
    const b = simulate(hot, { ...P, tech });
    assert.ok(b.makeupM3 > a.makeupM3, `${tech} water`);
    assert.ok(b.pue >= a.pue - 1e-9, `${tech} pue`);
    // strictly fewer compressor-free hours for chiller-based techs; evap-air
    // is compressor-free in both climates (its cost shows up as water instead)
    if (tech !== "evapair") {
      assert.ok(b.freeCoolShare < a.freeCoolShare, `${tech} free cooling`);
    }
  }
});

test("WUE and PUE land in the published envelope per technology (mid-EU climate)", () => {
  const clim = seasonalClimate(); // ~10 °C mean — central Europe
  const s = Object.fromEntries(
    compareTechs(clim, P).map((r) => [r.tech, r]));

  // WUE (L/kWh IT): towers ≈ 0.5–2.5 (industry surveys cluster ~1–2);
  // assist techs well under 0.5; dry techs ≈ base only.
  assert.ok(s.towers.wue > 0.5 && s.towers.wue < 2.5, `towers ${s.towers.wue}`);
  assert.ok(s.adiabatic.wue > 0.005 && s.adiabatic.wue < 0.5, `adiabatic ${s.adiabatic.wue}`);
  assert.ok(s.evapair.wue > 0.005 && s.evapair.wue < 0.5, `evapair ${s.evapair.wue}`);
  assert.ok(s.air.wue < 0.03 && s.liquid.wue < 0.03);

  // PUE ordering and range: every value in [1.05, 1.45]; liquid & evap-air
  // most efficient; dry air-cooled the most energy-hungry chilled-water tech.
  for (const r of Object.values(s)) assert.ok(r.pue > 1.05 && r.pue < 1.45, `${r.tech} ${r.pue}`);
  assert.ok(s.liquid.pue < s.towers.pue);
  assert.ok(s.evapair.pue < s.towers.pue);
  assert.ok(s.towers.pue < s.air.pue);
  // and the core trade: towers use less energy but far more water than air
  assert.ok(s.towers.wue > 20 * s.air.wue);
});

test("adiabatic assist only spends water above its switchover temperature", () => {
  const cold = simulate(constantClimate(18, 60), { ...P, tech: "adiabatic" });
  assert.ok(cold.evapM3 === 0, "no assist below switchover");
  const hot = simulate(constantClimate(30, 40), { ...P, tech: "adiabatic" });
  assert.ok(hot.evapM3 > 0);
  // raising the switchover shrinks water use
  const late = simulate(seasonalClimate(17, 10), { ...P, tech: "adiabatic", adbSwitchC: 27 });
  const early = simulate(seasonalClimate(17, 10), { ...P, tech: "adiabatic", adbSwitchC: 19 });
  assert.ok(late.makeupM3 < early.makeupM3);
});

// ----------------------------------------------------------- totals & scaling

test("monthly series sum exactly to annual totals; water scales with MW and load", () => {
  const clim = seasonalClimate();
  const s = simulate(clim, { ...P, coc: 4 });
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum(s.month.makeup) - s.makeupM3) < 1e-6);
  assert.ok(Math.abs(sum(s.month.evap) - s.evapM3) < 1e-6);
  assert.ok(Math.abs(sum(s.month.energy) - s.facilityMWh) < 1e-6);
  assert.ok(sum(s.month.hours) === clim.t2m.length);

  const double = simulate(clim, { ...P, mwIT: 120, coc: 4 });
  assert.ok(Math.abs(double.makeupM3 - 2 * s.makeupM3) / s.makeupM3 < 1e-9);
  const half = simulate(clim, { ...P, util: 0.4, coc: 4 });
  assert.ok(Math.abs(half.makeupM3 - 0.5 * s.makeupM3) / s.makeupM3 < 1e-9);
  // WUE and PUE are intensities — invariant to scale
  assert.ok(Math.abs(double.wue - s.wue) < 1e-9);
  assert.ok(Math.abs(double.pue - s.pue) < 1e-9);
});

test("peak day sits in summer and dominates the daily average", () => {
  const clim = seasonalClimate();
  const s = simulate(clim, P);
  const peakDoy = s.peakDayIdx;
  assert.ok(peakDoy > 120 && peakDoy < 273, `day ${peakDoy}`); // May–Sep
  // towers evaporate year-round (free-cooling mode still rejects IT heat wet),
  // so the summer peak day runs ~1.2–1.5× the daily average, not multiples
  assert.ok(s.peakDayM3 > 1.2 * (s.makeupM3 / 365));
});

// --------------------------------------------------------------- context math

test("upstream water = facility energy × grid intensity; perspective sanity", () => {
  const s = simulate(seasonalClimate(), P);
  assert.ok(Math.abs(upstreamM3(s, 1.1) - s.facilityMWh * 1.1) < 1e-9);
  const p = perspective(2500 * 10, 300);
  assert.ok(Math.abs(p.pools - 10) < 1e-9);
  assert.ok(Math.abs(p.tankersPeakDay - 10) < 1e-9);
  assert.ok(p.people > 500 && p.people < 600); // 25,000 m³ ≈ 571 people-years
});

test("WEI+ bands follow the EEA thresholds", () => {
  assert.equal(weiBand(5).label, "low stress");
  assert.equal(weiBand(15).label, "moderate stress");
  assert.equal(weiBand(25).label, "water stress");
  assert.equal(weiBand(45).label, "severe water stress");
  assert.equal(weiBand(null).label, "no data");
});

test("every advertised tech simulates and exposes the full result shape", () => {
  const clim = constantClimate(15, 70);
  for (const { key } of TECHS) {
    const s = simulate(clim, { ...P, tech: key });
    for (const k of ["makeupM3", "evapM3", "blowdownM3", "wue", "pue",
      "freeCoolShare", "peakDayM3", "facilityMWh"]) {
      assert.ok(Number.isFinite(s[k]), `${key}.${k}`);
    }
    assert.ok(s.freeCoolShare >= 0 && s.freeCoolShare <= 1);
  }
  assert.equal(DEFAULTS.coc, 4);
});
