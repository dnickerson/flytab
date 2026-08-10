/**
 * FlyTab — Flight Plan Package Model
 * Data model matching PRD Section 5.7.3 JSON format.
 */

class FlightPlanPackage {
    constructor() {
        this.version = 1;
        this.created_at = new Date().toISOString();
        this.updated_at = this.created_at;
        this.aircraft_id = null;
        this.flight_plan = {
            departure: null,
            destination: null,
            route: [],
            altitude: null,
            legs: [],
        };
        this.weather_cache = {
            fetched_at: null,
            metars: {},
            tafs: {},
            winds_aloft: {},
            pireps: [],
            sigmets: [],
            tfrs: [],
        };
        this.weight_balance = {
            scenario_name: null,
            stations: [],
            takeoff_weight: null,
            takeoff_cg: null,
            landing_weight: null,
            landing_cg: null,
            in_envelope: null,
        };
        this.ai_briefing = {
            summary: null,
            go_nogo: null,
            notam_highlights: [],
            generated_at: null,
        };
        this.official_briefing = {
            type: null,
            confirmation: null,
            obtained_at: null,
        };
        this.filed_plan = {
            status: null,
            flight_rules: null,
            flight_identifier: null,
            version_stamp: null,
            filed_at: null,
            proposed_departure: null,
            people_on_board: null,
            equipment_suffix: null,
            alternate: null,
            remarks: '',
        };
    }

    _touch() {
        this.updated_at = new Date().toISOString();
    }

    setAircraft(profile) {
        this.aircraft_id = profile.id;
        this._touch();
    }

    setRoute(departure, destination, waypoints, legs, altitude) {
        this.flight_plan.departure = departure;
        this.flight_plan.destination = destination;
        this.flight_plan.route = waypoints || [];
        this.flight_plan.legs = legs || [];
        this.flight_plan.altitude = altitude;
        this._touch();
    }

    setAltitude(altitude) {
        this.flight_plan.altitude = altitude;
        this._touch();
    }

    setLegs(legs) {
        this.flight_plan.legs = legs;
        this._touch();
    }

    setWeather(data) {
        this.weather_cache = {
            fetched_at: data.fetched_at || new Date().toISOString(),
            metars: data.metars || {},
            tafs: data.tafs || {},
            winds_aloft: data.winds_aloft || {},
            pireps: data.pireps || [],
            sigmets: data.sigmets || [],
            tfrs: data.tfrs || [],
        };
        this._touch();
    }

    setWeightBalance(wb) {
        this.weight_balance = {
            scenario_name: wb.scenario_name || null,
            stations: wb.stations || [],
            takeoff_weight: wb.takeoff_weight,
            takeoff_cg: wb.takeoff_cg,
            landing_weight: wb.landing_weight,
            landing_cg: wb.landing_cg,
            in_envelope: wb.in_envelope,
        };
        this._touch();
    }

    setAiBriefing(result) {
        this.ai_briefing = {
            summary: result.summary || null,
            go_nogo: result.go_nogo || null,
            notam_highlights: result.notam_highlights || [],
            generated_at: result.generated_at || new Date().toISOString(),
        };
        this._touch();
    }

    setOfficialBriefing(confirmation, type = 'standard') {
        this.official_briefing = {
            type: type,
            confirmation: confirmation,
            obtained_at: new Date().toISOString(),
        };
        this._touch();
    }

    setFiledPlan(filing) {
        this.filed_plan = {
            status: filing.status || 'filed',
            flight_rules: filing.flight_rules,
            flight_identifier: filing.flight_identifier,
            version_stamp: filing.version_stamp,
            filed_at: filing.filed_at || new Date().toISOString(),
            proposed_departure: filing.proposed_departure,
            people_on_board: filing.people_on_board,
            equipment_suffix: filing.equipment_suffix,
            alternate: filing.alternate || null,
            remarks: filing.remarks || '',
        };
        this._touch();
    }

    /**
     * Serialize to plain JSON object.
     */
    toJSON() {
        return {
            version: this.version,
            created_at: this.created_at,
            aircraft_id: this.aircraft_id,
            flight_plan: { ...this.flight_plan },
            weather_cache: { ...this.weather_cache },
            weight_balance: { ...this.weight_balance },
            ai_briefing: { ...this.ai_briefing },
            official_briefing: { ...this.official_briefing },
            filed_plan: { ...this.filed_plan },
        };
    }

    /**
     * Deserialize from JSON.
     */
    static fromJSON(json) {
        const pkg = new FlightPlanPackage();
        if (json.version) pkg.version = json.version;
        if (json.created_at) pkg.created_at = json.created_at;
        if (json.aircraft_id) pkg.aircraft_id = json.aircraft_id;
        if (json.flight_plan) Object.assign(pkg.flight_plan, json.flight_plan);
        if (json.weather_cache) Object.assign(pkg.weather_cache, json.weather_cache);
        if (json.weight_balance) Object.assign(pkg.weight_balance, json.weight_balance);
        if (json.ai_briefing) Object.assign(pkg.ai_briefing, json.ai_briefing);
        if (json.official_briefing) Object.assign(pkg.official_briefing, json.official_briefing);
        if (json.filed_plan) Object.assign(pkg.filed_plan, json.filed_plan);
        return pkg;
    }

    /**
     * Validate required fields. Returns array of issue strings (empty = valid).
     */
    validate() {
        const issues = [];
        if (!this.aircraft_id) issues.push('No aircraft selected');
        if (!this.flight_plan.departure) issues.push('No departure airport');
        if (!this.flight_plan.destination) issues.push('No destination airport');
        if (!this.flight_plan.legs || this.flight_plan.legs.length === 0) {
            issues.push('No route legs defined');
        }
        if (!this.flight_plan.altitude) issues.push('No altitude selected');
        return issues;
    }

    /**
     * Human-readable summary for Step 6 display.
     */
    getSummary() {
        const fp = this.flight_plan;
        const legs = fp.legs || [];
        const totalDist = legs.reduce((s, l) => s + (l.dist_nm || 0), 0);
        const totalTime = legs.reduce((s, l) => s + (l.ete_min || 0), 0);
        const totalFuel = legs.reduce((s, l) => s + (l.fuel_gal || 0), 0);
        const eteStr = `${Math.floor(totalTime / 60)}:${String(totalTime % 60).padStart(2, '0')}`;

        return {
            route: `${fp.departure || '?'} → ${fp.destination || '?'}`,
            routeString: fp.route.join(' '),
            altitude: fp.altitude ? `${fp.altitude} ft` : 'Not set',
            distance: `${Math.round(totalDist)} nm`,
            ete: eteStr,
            fuelRequired: `${totalFuel.toFixed(1)} gal`,
            weatherFetched: this.weather_cache.fetched_at || 'Not fetched',
            wbStatus: this.weight_balance.in_envelope === true ? 'In envelope'
                : this.weight_balance.in_envelope === false ? 'OUT OF ENVELOPE'
                : 'Not calculated',
            aiGoNogo: this.ai_briefing.go_nogo || 'Not analyzed',
            officialBriefing: this.official_briefing.confirmation || 'Not obtained',
            filedStatus: this.filed_plan.status || 'Not filed',
        };
    }
}
