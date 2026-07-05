// DC Lab shell: hash router and lazy view initialization. Two labs, one site.

import { initNoise } from "./noise.js";
import { initWater } from "./water.js";

const VIEWS = {
  noise: { init: initNoise, started: false },
  water: { init: initWater, started: false },
};

export async function showView(name) {
  if (!VIEWS[name]) name = "noise";
  document.querySelectorAll("#nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === `view-${name}`));

  const view = VIEWS[name];
  if (!view.started) {
    view.started = true;
    try {
      await view.init();
    } catch (err) {
      console.error(`view ${name} failed to initialize`, err);
      document.getElementById(`view-${name}`).insertAdjacentHTML(
        "afterbegin",
        `<div class="err" style="padding:20px">⚠ ${err.message} — are you online? The labs fetch open data (Open-Meteo, Eurostat) directly from your browser.</div>`,
      );
    }
  }
  // maps need a size poke when their container becomes visible
  window.dispatchEvent(new Event("resize"));
}

// hash carries a query for shareable scenarios: #water?lat=..&mw=..
const viewName = () => location.hash.slice(1).split("?")[0];
window.addEventListener("hashchange", () => showView(viewName()));
showView(viewName() || "noise");

// PDF report: lazy-load the builder on first use
document.getElementById("export-report").addEventListener("click", async () => {
  const { exportReport } = await import("./report.js");
  exportReport();
});
