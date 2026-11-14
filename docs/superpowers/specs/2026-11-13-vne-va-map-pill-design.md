# Vne / Va map pill — design (short)

Date: 2026-11-13. Builds on the uncommitted Vne at Altitude work on `feat/vne-tas-limit` (v13.12).

## Intent

Dana wants Vne-at-altitude and maneuvering speed on the map at all times, without opening a
menu. Van's Vne (182 kt) applies to IAS and TAS, so at altitude the IAS limit drops below the
D-180 red line. Va drops with weight. Tapping the pill opens a small card over the map for the
four things a pilot can read in the cockpit: altimeter setting, altitude, OAT (°F) and KIAS.

## Dana's decisions (2026-11-13)

- Pill on the map, under the engine box. Shows Vne and Va.
- Tap → **floating card** over the map (map stays visible), not the full-screen panel.
- Entries: **altimeter (inHg), altitude (ft, as indicated), OAT °F only, KIAS**.
- Va **reduced for weight**, weight from the W&B pilot/passenger/baggage entries plus fuel on board.
- W&B station weights are **saved until changed** (today they are lost on app restart).
- The MORE → In-flight → Vne at Altitude row is **removed**; the pill is the only way in.

## Approaches considered

1. **Rework `VnePanel` into the card, add a small `VnePill`** (chosen). One input/compute path;
   the full-screen panel is not needed once MORE is gone.
2. Keep the full-screen panel and add a second card. Two copies of the same entry form that
   can drift apart; rejected.
3. Put the pill inside `EngineOverlay`. Couples Vne to the engine box's enabled flag and
   field picker; rejected.

## Design

**Math (`web/shared/airspeed-limits.js`, pure):**
- `pressureAltFt(indicatedFt, altimeterInHg)` = indicated + 145,366.45 × (1 − (altimeter / 29.9213)^0.190263)
  (the standard altimeter equation). Altimeter range 27.50–31.50 inHg, typed values outside are
  rejected. The resulting pressure altitude must be inside the existing −1,000…18,000 ft range.
- `vaForWeight(weightLb, {grossLb = 1800, vaGrossKias = 102, pecKt})` =
  floor(min(102, 102 × √(W / gross)) − pec). Never above 102. Over gross is flagged, Va 102.
- `evaluate()` takes `{altimeter, alt, oatF, kias, weightLb}`; returns everything it does today
  plus `pressureAltFt` and `vaKias`.

**Weight (`VnePanel`):** `WbCalculator.calculate(profile, savedStationWeights, fuelGal).totalWeight`.
Fuel is `FuelState.measuredGallons()`; when it is null (nothing tracked) or `stale`, fuel is
**left out** (weight reads low → Va low, the safe direction) and the card says "fuel not counted".
With no pilot weight saved, Va shows "—" and the card says "Enter weights in W&B".

**W&B (`web/cockpit/wb-overlay.js`):** pilot/passenger/baggage inputs pre-fill from
`Settings.wbStationWeights` (`flypi_wb_station_weights`, `{ "Pilot": "190", ... }` keyed by
station name) and save on every edit; window event `wb:weightschanged` fires. The fuel field is
untouched (still pre-filled from the fuel tracker, never saved).

**Pill (`web/cockpit/vne-pill.js`, new):** `Vne 161 · Va 96` and the altitude it is for
(`@ 8,000`). "—" for any value that can't be computed. Never turns red (an old KIAS entry would
make that misleading); the over-Vne warning is in the card. Placed right side, just under the
engine box's last row (ResizeObserver on the box, re-found on `engineoverlay:fieldschanged`); at
156 px when the engine box is off. Recomputes on card edits, `wb:weightschanged`,
`fuelstate:changed`, `fueltankstate:changed`, and every 15 s (fuel burn).

**Card (`VnePanel` reworked):** right side under the pill, about 380 px wide, scrolls inside if
tall, ✕ to close. Entries with step buttons: altimeter ±0.01 (empty starts at 29.92), altitude
±500 (clamped), OAT °F ±1 (empty starts at ISA), KIAS ±1 with clear. Shows Vne here + which limit
governs, Va + the weights used, KIAS → KTAS + WITHIN / AT / OVER VNE (icon + text), pressure
altitude, density altitude, ISA deviation, Vno/Vfe line, position-error label, footnote.
Dropped from yesterday's panel: the °C/°F toggle, the KTAS entry, the full-screen layout.

**Saved entries:** `Settings.vneInputs` gets the new shape `{altimeter, alt, oatF, kias}`. No
migration: the old shape never shipped.

**Live hook:** `setInputs({pressureAltFt | altimeterInHg + indicatedAltFt, oatC | oatF, kias}, source)`.
A pressure altitude fills altimeter 29.92 + that altitude (same result).

## Non-goals

No live D-180 feed, no layer-panel toggle (always on), no Va change with altitude.

## Left to the builder

Exact card styling within the design tokens; pill font size (match engine box labels).
