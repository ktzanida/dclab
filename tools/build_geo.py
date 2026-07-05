"""Regenerate data/europe.geojson from the GISCO 1:20m world polygons.

Keeps the same country set (ids + names) as the currently bundled file, so a
rerun only refreshes geometries — do this when GISCO revises boundaries
(roughly yearly). No dependencies beyond the standard library.

Usage:  python3 tools/build_geo.py
"""

import json
import urllib.request
from pathlib import Path

URL = ("https://gisco-services.ec.europa.eu/distribution/v2/"
       "countries/geojson/CNTR_RG_20M_2024_4326.geojson")

out = Path(__file__).resolve().parents[1] / "data" / "europe.geojson"
keep = {
    f["properties"]["id"]: f["properties"]["name"]
    for f in json.loads(out.read_text())["features"]
}

world = json.loads(urllib.request.urlopen(URL, timeout=120).read())
features = [
    {
        "type": "Feature",
        "geometry": f["geometry"],
        "properties": {
            "id": f["properties"]["CNTR_ID"],
            "name": keep[f["properties"]["CNTR_ID"]],
        },
    }
    for f in world["features"]
    if f["properties"].get("CNTR_ID") in keep
]
assert len(features) == len(keep), "GISCO is missing a country we bundle"

out.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                          separators=(",", ":")))
print(f"{out}: {len(features)} countries, {out.stat().st_size / 1e6:.2f} MB")
