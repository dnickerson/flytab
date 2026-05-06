// @ts-check
'use strict';

/**
 * FisbWeather — WeatherSource backed by Stratux FIS-B JSON frames.
 *
 * The existing FisbClient already aggregates METARs, SIGMETs, AIRMETs by ICAO
 * / by ID into in-memory caches. This adapter exposes those caches behind the
 * planner's WeatherSource interface. No subscription bookkeeping in the
 * adapter — the existing client already maintains the caches.
 */
export class FisbWeather {
    constructor(fisbClient) { this._client = fisbClient; }

    async getMetar(icao) {
        const m = this._client?.getMetar?.(icao);
        if (!m) return null;
        return {
            station: icao,
            observed_at:  m.observed_at,
            wind_variable: !!m.wind_variable,
            wind_dir:    m.wind_dir ?? null,
            wind_speed:  m.wind_speed ?? null,
            wind_gust:   m.wind_gust ?? null,
            visibility:  m.visibility_sm ?? null,
            ceiling:     m.ceiling_ft ?? null,
            temp_c:      m.temp_c ?? null,
            dewpoint_c:  m.dewpoint_c ?? null,
            altim_inHg:  m.altimeter ?? null,
            raw:         m.raw,
        };
    }

    /** FIS-B does not provide winds aloft. */
    async getWindAloft() { return null; }

    async listActiveTfrs() { return []; /* FIS-B carries TFRs in graphical NOTAM frames; future. */ }
    async listSigmets()    { return this._client?.sigmets ?? []; }
    async listAirmets()    { return this._client?.airmets ?? []; }
}
