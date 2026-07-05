# References & validation

Every constant in DC Lab traces to a published source, and the model's *outputs*
are cross-checked against published facility-level data. This file is the audit
trail: part 1 lists the sources behind each assumption, part 2 compares what the
model produces against what operators, planners and surveys report.

Both physics engines also carry executable validation (`npm test`, 28 checks):
ISO 9613-1 reference magnitudes, Stull wet-bulb reference values, latent-heat and
cycles-of-concentration identities, closed-form hand-checks, and behavioral
invariants (barriers never amplify, hotter climates are thirstier, …).

---

## 1. Sources per assumption

### Water Lab — cooling thermodynamics

| Assumption | Value used | Source |
|---|---|---|
| Wet-bulb from dry-bulb + RH | Stull formula, ±0.3 °C | Stull, R. (2011), "Wet-Bulb Temperature from Relative Humidity and Air Temperature", *J. Appl. Meteor. Climatol.* 50:2267–2269, [doi:10.1175/JAMC-D-11-0143.1](https://doi.org/10.1175/JAMC-D-11-0143.1) |
| Latent heat anchor | 1.481 L evaporated per kWh rejected latently (λ ≈ 2,430 kJ/kg) | First-principles thermodynamics; the same anchor underlies all published WUE figures |
| Latent vs sensible split in towers | ~62 % near 0 °C → ~95 % hot days | SPX Cooling Technologies, *Cooling Tower Fundamentals* (Marley), ch. on evaporation & winter operation |
| Blowdown | makeup = evaporation × (1 + 1/(CoC−1)); CoC 2.5–8, default 4 | Standard cooling-tower water balance (ASHRAE Handbook — HVAC Systems & Equipment, cooling towers ch.) |
| Chiller COP curves | water-cooled ≈ 9.5 − 0.16·T_wb; air-cooled ≈ 5.8 − 0.075·T_db | Typical modern machine curves (AHRI-rated equipment ranges); disclosed as screening values |
| Economizer changeovers | WSE full below 8 °C wet-bulb → mechanical by 14 °C; dry coils 8→16 °C dry-bulb; 40 °C liquid loop dry below ~32 °C | Standard control sequences for elevated chilled-water / warm-water designs (ASHRAE 90.1 economizer practice) |
| WUE metric definition | site makeup L / IT kWh | The Green Grid, *Water Usage Effectiveness (WUE): A Green Grid Data Center Sustainability Metric* (WP#35, 2011) |
| Weather year | Hourly T2m + RH, most recent complete year, ERA5 reanalysis | [Open-Meteo archive API](https://open-meteo.com/en/docs/historical-weather-api) (ERA5, ECMWF) |

### Water Lab — grid (upstream) water intensity

| Assumption | Value used (L/kWh) | Source |
|---|---|---|
| Coal (tower) | 2.60 (687 gal/MWh median) | [Macknick et al. 2012, *Environ. Res. Lett.* 7 045802, table 2](https://iopscience.iop.org/article/10.1088/1748-9326/7/4/045802) |
| Natural gas CC (tower) | 0.78 (205 gal/MWh) | ibid. |
| Nuclear (tower) | 2.54 (672 gal/MWh) | ibid. |
| Biopower steam (tower) | 2.1 (553 gal/MWh); non-renewable waste assumed alike | ibid. |
| CSP trough (tower) | 3.4 (906 gal/MWh) | ibid. |
| Solar PV | 0.01 (~1 gal/MWh median, panel washing) | ibid. |
| Wind | ~0 | ibid. |
| Geothermal (flash + tower, EU-typical) | 0.06 (15 gal/MWh); binary plants run far higher — negligible EU share | ibid. |
| Oil steam | 1.6 — no Macknick median; assumed coal-like steam cycle | disclosed assumption |
| Hydro reservoir evaporation | 5.0, **as a toggle** — US gross median is 17 L/kWh (4,491 gal/MWh, ibid.); net estimates ~40 % lower ([Scherer & Pfister 2016](https://www.sciencedirect.com/science/article/abs/pii/S0960148116306176)); allocation contested ([Bakken et al. 2017 review](https://onlinelibrary.wiley.com/doi/full/10.1002/gch2.201600018)) | see left |
| Generation mix per country | Gross electricity production by fuel, latest year | Eurostat [`nrg_bal_peh`](https://ec.europa.eu/eurostat/databrowser/view/nrg_bal_peh/default/table) |

### Water Lab — stress & perspective context

| Assumption | Value used | Source |
|---|---|---|
| WEI+ index & series | consumption ÷ renewable freshwater, per country | Eurostat [`sdg_06_60`](https://ec.europa.eu/eurostat/databrowser/view/sdg_06_60/default/map) |
| Stress bands | >20 % = water stress, >40 % = severe | [EEA, water scarcity conditions in Europe (8th EAP indicator)](https://www.eea.europa.eu/en/analysis/publications/monitoring-progress-towards-8th-eap-objectives/indicators/24-water-scarcity-conditions-in-europe-water-exploitation-index-plus/@@download/file); EEA notes real WEI+ is basin-level and seasonal — the app repeats this caveat |
| Renewable freshwater volumes | latest reported, million m³ | Eurostat [`env_wat_res`](https://ec.europa.eu/eurostat/databrowser/view/env_wat_res/default/table) (`RFW_RES`); FAO AQUASTAT long-term averages where Eurostat lacks data (EL, IT, AT, DK, LU) |
| Household water use | 120 L/person·day | [EEA / Eurostat water statistics](https://ec.europa.eu/eurostat/statistics-explained/index.php?title=Water_statistics) (EU household use ≈ 40–50 m³/yr ≈ 110–140 L/day) |
| Public supply per capita | 75 m³/person·yr (households ≈ 77 % of public supply + services + losses) | [EEA, water abstraction by source and economic sector](https://www.eea.europa.eu/en/analysis/indicators/water-abstraction-by-source-and) |
| Irrigated farmland equivalent | 6,000 m³/ha·yr (southern-European maize) | FAO irrigation water requirement ranges (≈ 500–800 mm/season) |
| Olympic pool | 2,500 m³ | World Aquatics 50 m pool minimum (50 × 25 × 2 m) |

### Noise Lab

| Assumption | Value used | Source |
|---|---|---|
| Propagation method | ISO 9613-2 (divergence, ground effect, barrier, Cmet), stated accuracy ±3 dB | ISO 9613-2:1996 *Attenuation of sound during propagation outdoors* |
| Air absorption | full oxygen/nitrogen relaxation formula | ISO 9613-1:1993 |
| A-weighting | octave-band values | IEC 61672-1 |
| Equipment sound powers | chillers ≈ 99 dB(A)/unit, towers ≈ 97, dry coolers ≈ 93, AHU ≈ 94, silenced 2.5 MW gensets ≈ 108, transformers ≈ 90 with 100/125 Hz hum | Typical published vendor sound data (Carrier/Trane/BAC/Caterpillar sheets) and ASHRAE Applications Handbook ch. 49 ranges — screening values, editable in-app for manufacturer data |
| Lden weighting | day/evening/night +0/+5/+10 dB | Directive 2002/49/EC (Environmental Noise Directive) |
| Rating-level penalty | +5 dB where tonal plant is audible | BS 4142 / TA Lärm practice (simplified single step) |
| Night guideline anchor | 40 dB Lnight outside | [WHO *Night Noise Guidelines for Europe*, 2009](https://www.who.int/europe/publications/i/item/9789289041737) (interim target 55 dB) |
| Common limits quoted | ~55 dB(A) day / 40–45 dB(A) night residential | Typical EU member-state regulation (e.g. TA Lärm), quoted as indicative |

---

## 2. Model outputs vs published numbers

Cross-checks run at the app's defaults unless noted (60 MW IT, 80 % load).

| Quantity | This model | Published | Verdict |
|---|---|---|---|
| Annual water, tower-cooled campus in dry Spain | **709–733 thousand m³/yr** (Zaragoza, 60 MW towers, weather years 2024/2025) | Meta's planned Talavera de la Reina campus: **504–665 million L/yr** in planning documents ([Olive Press 2023](https://www.theolivepress.es/spain-news/2023/05/10/metas-planned-data-centre-for-toledo-town-will-require-660-million-litres-of-water-a-year/), [Green European Journal](https://www.greeneuropeanjournal.eu/dry-land-for-thirsty-data/)) | same order, right climate response ✓ |
| Share of a host city's water | our slider: 660 ML ≈ **10 %** of an ~84k-person utility | Talavera planning reports: "**roughly 8 %** of the city's total water consumption" ([Amwaj Alliance](https://amwaj-alliance.com/tayyarat/data-centres-spains-digital-boom-meets-environmental-limits/)) | ✓ |
| WUE, evaporative/tower cooling | **1.2–1.7 L/kWh** (climate-dependent) | Industry average ≈ **1.8–1.9 L/kWh** ([EESI](https://www.eesi.org/articles/view/data-centers-and-water-consumption), [LBNL 2024 US report](https://eta-publications.lbl.gov/sites/default/files/2024-12/lbnl-2024-united-states-data-center-energy-usage-report_1.pdf)); Google's evaporative sites up to 1.8, fleet **0.8–1.1** ([Google](https://datacenters.google/efficiency/)) | ✓ (EU climates run cooler than the US mix) |
| WUE, direct evaporative fresh-air | **~0.1–0.3 L/kWh** (0.21 in Zaragoza) | Meta new-build fleet WUE ≈ **0.20 L/kWh** ([Meta sustainability](https://sustainability.atmeta.com/water/)) | ✓ |
| WUE, adiabatic-assist | **~0.1–0.3 L/kWh** | Microsoft fleet WUE **0.30–0.49 L/kWh** ([Microsoft](https://datacenters.microsoft.com/sustainability/efficiency/)) | ✓ |
| WUE, dry/liquid cooling | **~0.02 L/kWh** (sanitary base only) | Microsoft zero-water-evaporation design: "near zero" cooling water ([Microsoft blog 2024](https://www.microsoft.com/en-us/microsoft-cloud/blog/2024/12/09/sustainable-by-design-next-generation-datacenters-consume-zero-water-for-cooling/)) | ✓ |
| PUE by technology | **1.13–1.32** (liquid → dry air-cooled, mid-EU climate) | Uptime Institute 2024 survey average **1.56** (all facility ages); modern hyperscale ≈ **1.09–1.10** ([Uptime 2024](https://intelligence.uptimeinstitute.com/resource/uptime-institute-global-data-center-survey-2024), [Google](https://datacenters.google/efficiency/)) | ✓ new-build envelope; the survey average includes legacy stock the model doesn't represent |
| National impact of one campus | ΔWEI+ ≈ **+0.001 points** (Greece example) | No published per-facility ΔWEI+ exists; consistent with EEA's point that scarcity must be judged at basin/seasonal scale ([EEA WEI+](https://www.eea.europa.eu/en/analysis/maps-and-charts/water-exploitation-index-plus-wei)) | plausibility ✓ |
| Noise at distance | 45–55 dB(A) contours hundreds of m to ~1–2 km for unmitigated large campuses | ISO 9613-2's own stated accuracy is ±3 dB; equipment inputs are vendor-typical, so treat contours as screening | method-validated (tests), inputs screening-grade |

### Known gaps (deliberate, disclosed in-app)

- **Basin-level stress**: the EEA computes WEI+ per river-basin district and quarter;
  the app shows the national annual value and says so. Bundling the EEA sub-basin
  dataset is the highest-value fidelity upgrade.
- **Weather year ≠ design envelope**: one real ERA5 year; drought/heat years run
  thirstier. A multi-year percentile band would bound this.
- **Noise source levels** are vendor-typical, not site-measured — the in-app editor
  exists precisely so a real project can paste manufacturer data.
- **Model PUE excludes legacy inefficiency** (survey averages include 15-year-old
  stock); it represents competently engineered new builds.
