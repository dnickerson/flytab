// @ts-check
'use strict';

/**
 * WeatherRouter — selects FisbWeather (in-flight tier) vs FlywhereWeather
 * (online tier) by NetworkStatus.mode().
 *
 * Mode mapping:
 *   'flight'                                   → inFlight adapter (FIS-B)
 *   'home' | 'internet'                        → online adapter (flywhere proxy)
 *   'offline'                                  → online adapter; let it throw
 *                                                WeatherUnavailable; caller
 *                                                handles cached fallback
 */
export class WeatherRouter {
    /**
     * @param {{mode: string}} network
     * @param {{inFlight: any, online: any}} tiers
     */
    constructor(network, tiers) {
        this._network = network;
        this._tiers   = tiers;
    }

    _pick() {
        return this._network.mode === 'flight' ? this._tiers.inFlight : this._tiers.online;
    }

    async getMetar(icao)         { return this._pick().getMetar(icao); }
    async getWindAloft(p, alt)   { return this._pick().getWindAloft(p, alt); }
    async listActiveTfrs()       { return this._pick().listActiveTfrs(); }
    async listSigmets()          { return this._pick().listSigmets(); }
    async listAirmets()          { return this._pick().listAirmets(); }
}
