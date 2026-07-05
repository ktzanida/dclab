// Validation suite for the Noise Lab acoustics engine (static/js/noise-model.js).
//
// These are physics checks, not UI tests: reference values from ISO 9613-1,
// internal-consistency checks (grid vs point evaluator, energy bookkeeping),
// and behavioral invariants every propagation model must satisfy (divergence
// slope, barriers never amplify, upwind quieter than downwind, …).
//
// Run with:  npm test   (or: node --test tests/)

import test from "node:test";
import assert from "node:assert/strict";
import {
  A_WEIGHT, BANDS, airAbsorption, buildScenario, computeGrid, distanceTo,
  ldenCombine, levelAt, ratingLevel, suggestExtent,
} from "../js/noise-model.js";

const P = { mw: 60, cooling: "air", gensetTest: false, pkg: false, metric: "day" };

function makeEnv(scenario, over = {}) {
  return {
    alpha: airAbsorption(15, 70), G: 0.5, wallH: 0, S: scenario.wallDist,
    hr: 1.5, c0max: 0, windTo: 0, ...over,
  };
}

// --------------------------------------------------------- ISO 9613-1 absorption

test("air absorption matches ISO 9613-1 reference magnitudes (20 °C, 70 % RH)", () => {
  const dBkm = airAbsorption(20, 70).map((a) => a * 1000);
  // Hand-computed from the standard's formula (oxygen/nitrogen relaxation):
  // 1 kHz ≈ 5.0 dB/km, 8 kHz ≈ 77 dB/km at 101.325 kPa.
  assert.ok(dBkm[4] > 4.4 && dBkm[4] < 5.6, `1 kHz: ${dBkm[4]}`);
  assert.ok(dBkm[7] > 68 && dBkm[7] < 88, `8 kHz: ${dBkm[7]}`);
  // absorption grows monotonically with frequency
  for (let b = 1; b < 8; b++) assert.ok(dBkm[b] > dBkm[b - 1], `band ${b}`);
});

test("cold dry air absorbs mid/high frequencies harder than mild humid air", () => {
  const cold = airAbsorption(-5, 40), mild = airAbsorption(20, 70);
  assert.ok(cold[4] > 1.5 * mild[4]); // 1 kHz
  assert.ok(cold[5] > 1.5 * mild[5]); // 2 kHz
});

// ----------------------------------------------------------------- scenario math

test("group sound power is unit level + 10·log10(count), energy-summed total", () => {
  const sc = buildScenario(P);
  for (const g of sc.groups) {
    assert.ok(Math.abs(g.groupLwa - (g.unitLwa + 10 * Math.log10(g.count))) < 1e-9);
  }
  const e = sc.groups.reduce((s, g) => s + 10 ** (g.groupLwa / 10), 0);
  assert.ok(Math.abs(sc.totalLwa - 10 * Math.log10(e)) < 1e-9);
});

test("source clustering conserves acoustic energy exactly", () => {
  const sc = buildScenario(P);
  for (const g of sc.groups) {
    const pts = sc.sources.filter((s) => s.group === g.kind);
    const e = pts.reduce((sum, s) =>
      sum + s.lw.reduce((a, lw, b) => a + 10 ** ((lw + A_WEIGHT[b]) / 10), 0), 0);
    assert.ok(Math.abs(10 * Math.log10(e) - g.groupLwa) < 1e-6, g.kind);
  }
});

test("Lden combination formula (2002/49/EC): equal periods → +6.4 dB", () => {
  // 12h·L + 4h·(L+5) + 8h·(L+10) energy-averaged over 24 h
  assert.ok(Math.abs(ldenCombine(50, 50, 50) - 56.4) < 0.05);
  // Lden of a constant 24/7 source is bounded by its night-weighted level
  assert.ok(ldenCombine(50, 50, 50) < 60);
});

test("night metric is quieter and drops generator tests", () => {
  const day = buildScenario({ ...P, gensetTest: true });
  const night = buildScenario({ ...P, gensetTest: true, metric: "night" });
  assert.ok(night.totalLwa < day.totalLwa);
  assert.ok(!night.groups.some((g) => g.kind === "genset"));
  assert.ok(day.groups.some((g) => g.kind === "genset"));
});

test("source overrides: LwA shifts the group; count 0 removes it", () => {
  const base = buildScenario(P);
  const quiet = buildScenario({ ...P, overrides: { chiller: { lwa: 89 } } });
  const gBase = base.groups.find((g) => g.kind === "chiller");
  const gQuiet = quiet.groups.find((g) => g.kind === "chiller");
  assert.ok(Math.abs(gBase.groupLwa - 10 - gQuiet.groupLwa) < 1e-9);
  const none = buildScenario({ ...P, overrides: { chiller: { count: 0 } } });
  assert.ok(!none.groups.some((g) => g.kind === "chiller"));
});

// ------------------------------------------------------------------- propagation

test("far-field divergence: doubling distance loses ≈ 6 dB (+ excess attenuation)", () => {
  const sc = buildScenario(P);
  const env = makeEnv(sc);
  const l2 = levelAt(sc, env, 2000, 0).laeq;
  const l4 = levelAt(sc, env, 4000, 0).laeq;
  const drop = l2 - l4;
  assert.ok(drop > 5.5 && drop < 14, `drop ${drop}`); // 6 dB + air/ground excess
});

test("rating level: +5 penalty only when tonal plant is within 6 dB of total", () => {
  assert.equal(ratingLevel(50, 47), 55);
  assert.equal(ratingLevel(50, 43), 50);
});

test("tonal contribution never exceeds the total", () => {
  const sc = buildScenario({ ...P, gensetTest: true });
  const env = makeEnv(sc);
  for (const [x, y] of [[300, 0], [-800, 200], [0, 2000]]) {
    const at = levelAt(sc, env, x, y);
    assert.ok(at.tonalDb <= at.laeq + 1e-9);
  }
});

test("a perimeter wall attenuates ground-level plant and never amplifies", () => {
  const sc = buildScenario({ ...P, cooling: "towers", gensetTest: true });
  const env = makeEnv(sc);
  const envW = makeEnv(sc, { wallH: 8 });
  for (const [x, y] of [[400, 0], [-400, 0], [0, 600], [1000, 1000]]) {
    const open = levelAt(sc, env, x, y).laeq;
    const walled = levelAt(sc, envW, x, y).laeq;
    assert.ok(walled <= open + 1e-9, `(${x},${y})`);
  }
  // and it must actually do something near ground-level sources
  assert.ok(levelAt(sc, envW, 400, 0).laeq < levelAt(sc, env, 400, 0).laeq - 0.5);
});

test("long-term meteorology: upwind quieter, downwind unchanged (ISO 9613-2 §8)", () => {
  const sc = buildScenario(P);
  const worst = makeEnv(sc);
  const avg = makeEnv(sc, { c0max: 3, windTo: 0 }); // sound carried toward +x
  const downwind = [1500, 0], upwind = [-1500, 0];
  assert.ok(Math.abs(levelAt(sc, avg, ...downwind).laeq - levelAt(sc, worst, ...downwind).laeq) < 0.05);
  const dUp = levelAt(sc, worst, ...upwind).laeq - levelAt(sc, avg, ...upwind).laeq;
  assert.ok(dUp > 2 && dUp <= 3.01, `upwind Cmet ${dUp}`);
});

// ---------------------------------------------------------- field grid & helpers

test("grid agrees with the point evaluator at exact node coordinates", () => {
  const sc = buildScenario(P);
  const env = makeEnv(sc);
  const half = 2000, n = 41;
  const { laeq, tonal } = computeGrid(sc, env, half, n);
  const step = (2 * half) / (n - 1);
  for (const [i, j] of [[5, 5], [20, 20], [35, 10], [20, 38]]) {
    const at = levelAt(sc, env, -half + i * step, -half + j * step);
    assert.ok(Math.abs(laeq[j * n + i] - at.laeq) < 0.01, `laeq (${i},${j})`);
    assert.ok(Math.abs(tonal[j * n + i] - at.tonalDb) < 0.01, `tonal (${i},${j})`);
  }
});

test("distance-to-level is monotone in level; extent covers the display floor", () => {
  const sc = buildScenario(P);
  const env = makeEnv(sc);
  const f = (x, y) => levelAt(sc, env, x, y).laeq;
  const half = suggestExtent(f, 28);
  assert.ok(half >= 500);
  assert.ok(f(half, 0) < 31); // faded out before the raster edge
  const d45 = distanceTo(f, sc.wallDist, 45, half * 1.5);
  const d40 = distanceTo(f, sc.wallDist, 40, half * 1.5);
  assert.ok(d40 > d45 && d45 > 0);
});

test("every shared cooling technology maps to a working plant set", () => {
  const totals = {};
  for (const cooling of ["air", "towers", "liquid", "adiabatic", "evapair"]) {
    const sc = buildScenario({ ...P, cooling });
    assert.ok(sc.sources.length > 0, cooling);
    assert.ok(Number.isFinite(sc.totalLwa), cooling);
    totals[cooling] = sc.totalLwa;
  }
  // acoustic mapping: adiabatic pads are silent → same plant as air-cooled;
  // fan-wall-only direct evaporative is the quietest of the wet options
  assert.equal(totals.adiabatic, totals.air);
  assert.ok(totals.evapair < totals.air);
});
