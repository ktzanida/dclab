// The facility both labs describe — one site, one size, one cooling system.
//
// A tiny shared store: the Noise Lab and the Water Lab read and write the
// same { lat, lon, mw, tech }, so dragging the building in one lab moves it
// in the other, and the cooling technology you price for water is the same
// one that makes the noise. Lab-specific parameters (noise metric, average
// IT load, cycles of concentration, …) stay in their own lab.
//
// Views subscribe with (patch, src) callbacks; `src` names the origin
// ("noise", "water", "hash-…") so a view can skip map re-centering on its
// own edits while still recomputing on everyone's.

import { TECHS } from "./water-model.js";

const subs = new Set();

export const facility = {
  lat: 41.65, lon: -0.88, // Aragón, Spain — the heart of Europe's data-center siting debate
  mw: 60,                 // IT capacity, MW
  tech: "towers",         // one of water-model.js TECHS keys

  set(patch, src) {
    Object.assign(facility, patch);
    for (const fn of subs) fn(patch, src);
  },
  subscribe(fn) { subs.add(fn); },
};

// Render the shared cooling-technology picker into `container`; clicks write
// to the store tagged with `src`. Returns a sync() the view calls from its
// subscription to reflect changes made in the other lab.
export function buildTechPicker(container, src) {
  container.innerHTML = TECHS.map(({ key, short, blurb }) => `
    <button data-tech="${key}">
      <span class="wl-tech-name">${short}</span>
      <span class="wl-tech-blurb">${blurb}</span>
    </button>`).join("");
  const sync = () => container.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tech === facility.tech));
  container.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => facility.set({ tech: b.dataset.tech }, src)));
  sync();
  return sync;
}
