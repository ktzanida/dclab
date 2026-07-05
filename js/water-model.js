// Water Lab — the thermodynamics engine.
//
// An hourly (8,760 h) simulation of data-center cooling water use, driven by a
// real "typical meteorological year" (PVGIS TMY) at the chosen site. For every
// hour and every cooling technology it answers three coupled questions:
//
//   1. What operating mode is the plant in?  (free cooling / partial /
//      mechanical / evaporative-assist — decided by dry-bulb or wet-bulb
//      temperature, exactly as real control sequences do)
//   2. How much heat is rejected, and how much of it leaves as evaporated
//      water?  (latent heat of vaporization ≈ 2.43 MJ/kg → evaporating one
//      liter removes ≈ 0.675 kWh; the inverse, 1.481 L/kWh, is the physical
//      anchor every published WUE number reduces to)
//   3. How much electricity does the cooling plant draw?  (temperature-
//      dependent chiller COP + fan/pump parasitics → hourly PUE, which in
//      turn drives the *upstream* water the electricity itself consumed at
//      the power plant)
//
// Direct water bookkeeping follows cooling-tower practice:
//
//   evaporation  E = Q_rejected · f_latent / λ        (consumed, leaves as vapor)
//   blowdown     B = E / (CoC − 1)                    (returned, concentrated)
//   makeup       M = E + B  (+ drift, ~0.001 % — negligible, ignored)
//
// where CoC is cycles of concentration and f_latent the share of heat leaving
// the tower as latent rather than sensible heat (temperature-dependent: cold
// air carries more heat sensibly, which is why winter towers evaporate less
// per kWh — SPX/Marley "Cooling Tower Fundamentals", ch. 4).
//
// Wet-bulb from dry-bulb + RH uses Stull (2011, J. Appl. Meteor. Climatol.
// 50:2267), accurate to ±0.3 °C over the meteorological range.
//
// Everything is deliberately dependency-free and fast: one year × six
// technologies is ~50k scalar operations — instant on every slider move.

// ------------------------------------------------------------------ constants

// L of water evaporated per kWh of heat rejected latently (λ ≈ 2430 kJ/kg at a
// ~30 °C water film; 3600/2430 = 1.481).
export const LATENT_L_PER_KWH = 1.481;

// Non-cooling site water (sanitary, humidification trim, technical cleaning),
// per kWh of IT energy served. Small by design — cooling dominates.
const BASE_L_PER_KWH_IT = 0.02;

// Electrical overhead outside the cooling plant (UPS + transformer losses,
// lighting, controls) as a fraction of IT power. Feeds PUE only.
const ELEC_OVERHEAD = 0.06;

// Air-loop distribution (CRAH/CRAC fans + CHW pumps) for chilled-water techs,
// as a fraction of IT power.
const DIST_OVERHEAD = 0.055;

// ------------------------------------------------------------------ wet bulb

// Stull (2011) empirical wet-bulb, °C from dry-bulb °C and RH %.
// Valid RH 5–99 %, T −20…50 °C — clamped to that envelope.
export function wetBulb(t, rh) {
  rh = Math.min(99, Math.max(5, rh));
  const tw =
    t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(t + rh) - Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;
  return Math.min(t, tw);
}

// Linear ramp: 0 below a, 1 above b — the shape of every real changeover
// control sequence (free cooling → partial → full mechanical).
const ramp = (x, a, b) => Math.min(1, Math.max(0, (x - a) / (b - a)));

// Share of tower heat leaving as latent (evaporation) rather than sensible
// heat, vs dry-bulb. ~0.62 near freezing, ~0.95 on a hot day — consistent
// with the winter-evaporation reduction in tower vendor data.
export const latentFraction = (tdb) => Math.min(0.98, Math.max(0.55, 0.62 + 0.011 * tdb));

// Chiller COPs vs the temperature their condenser actually sees — typical
// modern-machine curves (elevated 16–18 °C chilled-water supply):
//   water-cooled centrifugal, condenser water ≈ wet-bulb + approach
//   air-cooled screw, condenser air = dry-bulb
export const copWaterCooled = (twb) => Math.min(9.5, Math.max(4.0, 9.5 - 0.16 * Math.max(twb, 5)));
export const copAirCooled = (tdb) => Math.min(5.8, Math.max(2.7, 5.8 - 0.075 * Math.max(tdb, 0)));

// ------------------------------------------------------------------ the techs
//
// Each tech maps one hour of weather to, per kWh of IT energy:
//   evapL      water evaporated (consumed — leaves as vapor)
//   makeupL    water drawn from supply (evap + blowdown / overspray / bleed)
//   coolkWh    cooling-plant electricity (chillers + heat-rejection fans/pumps)
//   free       1 if fully compressor-free this hour
//
// p carries user parameters: { coc, adbSwitchC }.

const TECH_DEF = {
  towers: {
    label: "Water-cooled chillers + cooling towers",
    short: "Cooling towers",
    blurb: "Most water, least cooling energy — the classic hyperscale trade.",
    hour(tdb, twb, p) {
      // Water-side economizer: full free cooling below 8 °C wet-bulb
      // (16 °C CHW − 4 K plate HX − 4 K tower approach), full chiller by 14 °C.
      const x = ramp(twb, 8, 14); // fraction of load on chillers
      const cop = copWaterCooled(twb);
      const chillerKWh = x / cop;
      const qRej = 1 + chillerKWh; // IT heat + compressor heat, all via the tower
      const evapL = qRej * latentFraction(tdb) * LATENT_L_PER_KWH;
      return {
        evapL,
        makeupL: evapL * (1 + 1 / (p.coc - 1)), // + blowdown
        coolkWh: chillerKWh + 0.012 * qRej + 0.035, // tower fans + CW/CHW pumps
        free: x === 0 ? 1 : 0,
      };
    },
  },

  adiabatic: {
    label: "Air-cooled chillers + adiabatic pre-cooling",
    short: "Adiabatic hybrid",
    blurb: "Dry all year except hot hours, when spray pads knock the condenser air toward wet-bulb.",
    hour(tdb, twb, p) {
      const assist = tdb > p.adbSwitchC;
      // Wetted pads at ~65 % effectiveness depress condenser-inlet air
      const tEff = assist ? tdb - 0.65 * (tdb - twb) : tdb;
      const x = ramp(tEff, 8, 16); // dry free-cooling coil below, chiller above
      const cop = copAirCooled(tEff);
      const chillerKWh = x / cop;
      let evapL = 0;
      if (assist) {
        // Energy balance of the depression: pads evaporate exactly the water
        // needed to cool the air stream by (tdb − tEff); the air stream is
        // sized by the coil's ~10 K design rise over rejected heat.
        const qRej = 1 + chillerKWh;
        evapL = qRej * ((tdb - tEff) / 10) * LATENT_L_PER_KWH;
      }
      return {
        evapL,
        makeupL: evapL * 1.15, // ~15 % overspray runs to drain (no recirculation)
        coolkWh: chillerKWh + 0.025,
        free: x === 0 ? 1 : 0,
      };
    },
  },

  air: {
    label: "Air-cooled chillers (dry)",
    short: "Air-cooled",
    blurb: "Zero site water, highest cooling energy — the desert-and-drought choice.",
    hour(tdb) {
      const x = ramp(tdb, 8, 16);
      return { evapL: 0, makeupL: 0, coolkWh: x / copAirCooled(tdb) + 0.025, free: x === 0 ? 1 : 0 };
    },
  },

  evapair: {
    label: "Direct evaporative fresh-air",
    short: "Direct evaporative",
    blurb: "Outside air through wetted media — near-zero energy overhead, water only on hot days.",
    hour(tdb, twb) {
      // Fresh-air supply target 25 °C, hot-aisle return 37 °C (12 K rise).
      // Cool hours: pure outside air. Hot hours: media at 85 % effectiveness
      // cools the air toward wet-bulb; the evaporated water is set by the
      // depression achieved vs the 12 K the air stream absorbs from IT.
      if (tdb <= 25) return { evapL: 0, makeupL: 0, coolkWh: 0.045, free: 1 };
      const tSup = tdb - 0.85 * (tdb - twb);
      const dep = tdb - tSup;
      const rise = Math.max(4, 37 - tSup);
      const evapL = (dep / rise) * LATENT_L_PER_KWH;
      // beyond 27 °C supply (ASHRAE A1 allowable) a DX trim coil tops up —
      // rare in European climates, but hot humid spells hit it
      const trim = Math.max(0, tSup - 27) / 12;
      return {
        evapL,
        makeupL: evapL * 1.1, // ~10 % bleed keeps the media from scaling up
        coolkWh: 0.05 + trim / copAirCooled(tdb),
        free: trim === 0 ? 1 : 0,
      };
    },
  },

  liquid: {
    label: "Direct liquid cooling + dry coolers",
    short: "Liquid (DLC)",
    blurb: "Warm-water loop rejects heat dry nearly all year — lowest energy and no water, but only for liquid-ready IT.",
    hour(tdb, twb, p) {
      // The 40 °C facility loop runs dry below ~32 °C ambient (8 K approach);
      // a trim chiller ramps in above. Real DLC halls still cool part of the
      // load with air (network gear, storage) — modelled as an air-cooled
      // chiller slice.
      const airShare = 0.25;
      const trim = ramp(tdb, 32, 38);
      const dlc = { coolkWh: 0.045 + trim / copAirCooled(tdb), free: trim === 0 ? 1 : 0 };
      const airBit = TECH_DEF.air.hour(tdb, twb, p);
      return {
        evapL: 0,
        makeupL: 0,
        coolkWh: (1 - airShare) * dlc.coolkWh + airShare * airBit.coolkWh,
        free: Math.min(dlc.free, airBit.free),
      };
    },
  },
};

export const TECHS = Object.entries(TECH_DEF).map(([key, t]) => ({
  key, label: t.label, short: t.short, blurb: t.blurb,
}));

export const DEFAULTS = { coc: 4, adbSwitchC: 22 };

// ------------------------------------------------------------------ simulation
//
// climate: { months: int[8760] (1–12), t2m: number[8760], rh: number[8760] }
// params:  { tech, mwIT, util (0–1), coc, adbSwitchC }
//
// Returns annual totals, monthly series, peaks and design conditions — all in
// physical units for a facility of mwIT MW running at `util` average load.

export function simulate(climate, params) {
  const p = { ...DEFAULTS, ...params };
  const tech = TECH_DEF[p.tech] ?? TECH_DEF.towers;
  const n = climate.t2m.length;
  const itMWh = p.mwIT * p.util; // MWh of IT energy per hour (flat profile)

  const month = {
    makeup: new Array(12).fill(0), evap: new Array(12).fill(0),
    blowdown: new Array(12).fill(0), energy: new Array(12).fill(0),
    hours: new Array(12).fill(0), freeHours: new Array(12).fill(0),
    tAvg: new Array(12).fill(0),
  };
  let evapY = 0, makeupY = 0, coolY = 0, freeH = 0;
  let peakDayM3 = 0, peakDayIdx = 0, peakDayT = -99;
  let dayM3 = 0, dayTmax = -99;
  let tdbMax = -99, twbMax = -99;

  for (let i = 0; i < n; i++) {
    const tdb = climate.t2m[i], rh = climate.rh[i];
    const twb = wetBulb(tdb, rh);
    const h = tech.hour(tdb, twb, p);

    // per-kWh-IT → facility-hour physical units
    const evapM3 = (h.evapL * itMWh); // L/kWh × MWh = m³
    const makeupM3 = ((h.makeupL + BASE_L_PER_KWH_IT) * itMWh);
    const m = climate.months[i] - 1;
    month.evap[m] += evapM3;
    month.makeup[m] += makeupM3;
    month.blowdown[m] += makeupM3 - evapM3;
    month.energy[m] += (1 + h.coolkWh + ELEC_OVERHEAD + DIST_OVERHEAD) * itMWh;
    month.hours[m]++;
    month.freeHours[m] += h.free;
    month.tAvg[m] += tdb;

    evapY += evapM3;
    makeupY += makeupM3;
    coolY += h.coolkWh * itMWh;
    freeH += h.free;
    if (tdb > tdbMax) tdbMax = tdb;
    if (twb > twbMax) twbMax = twb;

    // daily peak (TMY hours run Jan 1 00:00 → Dec 31 23:00)
    dayM3 += makeupM3;
    dayTmax = Math.max(dayTmax, tdb);
    if (i % 24 === 23 || i === n - 1) {
      if (dayM3 > peakDayM3) {
        peakDayM3 = dayM3; peakDayIdx = Math.floor(i / 24); peakDayT = dayTmax;
      }
      dayM3 = 0; dayTmax = -99;
    }
  }

  for (let m = 0; m < 12; m++) month.tAvg[m] /= Math.max(1, month.hours[m]);

  const itY = itMWh * n;                       // MWh IT / yr
  const overheadY = (ELEC_OVERHEAD + DIST_OVERHEAD) * itY + coolY;
  const facilityY = itY + overheadY;           // MWh facility / yr
  const pue = facilityY / itY;

  return {
    tech: p.tech,
    month,
    itMWh: itY,
    facilityMWh: facilityY,
    pue,
    makeupM3: makeupY,
    evapM3: evapY,
    blowdownM3: makeupY - evapY,
    wue: makeupY * 1000 / (itY * 1000),        // L per kWh IT (Green Grid WUE)
    freeCoolShare: freeH / n,
    peakDayM3, peakDayIdx, peakDayT,
    design: { tdbMax, twbMax },
  };
}

// Upstream (scope-2) water: the electricity the whole facility draws was
// itself generated somewhere, consuming `gridLperKWh` liters per kWh (from
// the country's actual generation mix). Green Grid calls the combined number
// WUE_source.
export function upstreamM3(sim, gridLperKWh) {
  return sim.facilityMWh * gridLperKWh; // MWh × L/kWh = m³
}

// Run every technology under identical conditions — the comparison that makes
// the water⇄energy trade-off visible.
export function compareTechs(climate, params) {
  return TECHS.map(({ key }) => simulate(climate, { ...params, tech: key }));
}

// ------------------------------------------------------------ put in perspective
//
// The numbers people can *feel*. Sources: Olympic pool 2,500 m³ (FINA minimum);
// EU household water use ≈ 120 L/person/day (EEA); irrigated maize in southern
// Europe ≈ 6,000 m³/ha/yr (FAO); a road tanker ≈ 30 m³.

export function perspective(makeupM3yr, peakDayM3) {
  return {
    pools: makeupM3yr / 2500,
    people: makeupM3yr / (0.120 * 365),
    irrigatedHa: makeupM3yr / 6000,
    tankersPeakDay: peakDayM3 / 30,
  };
}

// EEA reading of the Water Exploitation Index plus.
export function weiBand(v) {
  if (v == null) return { label: "no data", color: "#64748b" };
  if (v < 10) return { label: "low stress", color: "#34d399" };
  if (v < 20) return { label: "moderate stress", color: "#fbbf24" };
  if (v < 40) return { label: "water stress", color: "#f97316" };
  return { label: "severe water stress", color: "#ef4444" };
}
