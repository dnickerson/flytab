# FlyTab Changelog

---

## v5.14 — 2026-04-16

### ForeFlight-style map and instrument improvements

**METAR flight category colors on airport icons (#34)**
Airport dots are now colored by current flight condition: green (VFR), blue (MVFR), red (IFR), purple (LIFR). Uses FIS-B live data in flight; falls back to internet-fetched METARs when FIS-B is unavailable. No METAR = neutral base icon.

**Towered vs non-towered airport icon style (#35)**
Towered airports show a solid ring; non-towered airports show a dashed ring. Matches the ForeFlight convention and makes class D/E field distinctions visible at a glance.

**Track vector — 3-minute lookahead (#37)**
A white vector line extends from ownship in the direction of current track, scaled to 3 minutes of flight at current ground speed. Only visible when GS > 10 kts. Gives a quick sense of where you'll be relative to traffic and airspace.

**Nearest baro station in instrument strip (#40)**
New `baro` field in the instrument strip shows the altimeter setting from the nearest airport with a METAR. The label updates to the station ICAO (e.g. `KLKR`). Recalculates every 30 seconds or after moving more than 1 NM.

**Config cache fix**
`cockpit-config.json` is now fetched with `cache: reload` so APK updates always apply the new config rather than serving a stale HTTP-cached version.

---

## v5.13 — 2026-04-15

### Map display correctness (Leaflet audit PRs #59, #60)

- NEXRAD tiles now use `updateWhenZooming: false` to prevent rendering artifacts during zoom (#48)
- Route waypoint labels suppress below zoom 9 to reduce clutter (#50)
- Emergency glide circle animation disabled (`animate: false`) to prevent WebView jank (#51)
- PIREP markers moved to z-index 400 (below traffic at 500) (#54)
- Radar loop scoped to map page only — no longer runs in background on other tabs (#58)

---

## v5.03 — 2026-04-14

- Waypoint distance and descent rate columns in route table
- Engine chart sizing improvements
- Route summary bar packed with trip data and live fuel@dest

---

## v5.02 — 2026-04-13

- Route summary bar with trip totals and live fuel-at-destination
- Wind correction angle and HDG in route table

---

## v5.01 — 2026-04-12

- Route display and route editor separation (display-only vs edit mode)

---

## v5.00 — 2026-04-11

- Route nav strip with next waypoint, bearing, distance
- ADS-B display fix
- Config persistence via separate localStorage key
- Airport sidebar fixes
