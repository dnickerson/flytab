// @ts-check
'use strict';

import { PlanError } from '../planning/planner/route-planner-errors.js';

export class WeatherUnavailable extends PlanError {
    constructor(reason) { super(`Weather data unavailable: ${reason}`); this.name = 'WeatherUnavailable'; }
}

/**
 * FlywhereWeather — WeatherSource backed by https://flywhere.app/api/wx/*.
 *
 * Endpoint design is deferred (see planning-lib sketch §3). This adapter
 * implements the contract; each method throws WeatherUnavailable until the
 * endpoint is live, at which point only the body of each method needs to
 * be filled in.
 */
export class FlywhereWeather {
    constructor(baseUrl = 'https://flywhere.app/api/wx') { this._base = baseUrl; }

    async getMetar(icao) {
        try {
            const resp = await fetch(`${this._base}/metar?icao=${encodeURIComponent(icao)}`);
            if (!resp.ok) throw new WeatherUnavailable(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (e instanceof WeatherUnavailable) throw e;
            throw new WeatherUnavailable(e.message || String(e));
        }
    }

    async getWindAloft(point, altFt) {
        try {
            const url = `${this._base}/winds-aloft?lat=${point.lat}&lon=${point.lon}&alt=${altFt}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new WeatherUnavailable(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (e instanceof WeatherUnavailable) throw e;
            throw new WeatherUnavailable(e.message || String(e));
        }
    }

    async listActiveTfrs() { return this._fetchList('tfrs'); }
    async listSigmets()    { return this._fetchList('sigmets'); }
    async listAirmets()    { return this._fetchList('airmets'); }

    async _fetchList(path) {
        try {
            const resp = await fetch(`${this._base}/${path}`);
            if (!resp.ok) throw new WeatherUnavailable(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (e instanceof WeatherUnavailable) throw e;
            throw new WeatherUnavailable(e.message || String(e));
        }
    }
}
