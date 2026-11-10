/**
 * FlyTab — Synthetic Per-Tank Fuel State
 * Integrates measured fuel flow against pilot-reported tank selection.
 * Flight-safety critical: errors cause fuel exhaustion risk.
 * Never auto-corrects from senders. Requires human-in-the-loop confirmation.
 */

class FuelTankState {
    static STORAGE_KEY = 'flytab_tank_state';
    /** If last sample is older than this, require confirmation before trusting state */
    static STALE_MS = 45 * 60 * 1000;
    /** Imbalance warning threshold in gallons */
    static IMBALANCE_GAL = 5;
    /** How often to prompt pilot to confirm current tank selection */
    static CONFIRM_INTERVAL_MS = 30 * 60 * 1000;
    /** Cap dt between samples to avoid large jumps on reconnect */
    static MAX_SAMPLE_DT_MS = 10000;
    /** markFlowLost(): with no current frame seen yet this session (app restart), the
     *  engine counts as running if burn was integrated (last_burn_at) this recently. */
    static RECENT_BURN_MS = 2 * 60 * 1000;
    /** markFlowLost(): the last current frame counts as "engine running" only above
     *  this RPM. A stopped engine can still report residual flow (3 of 126 recorded
     *  flights end with RPM 0 and Fuel Flow 0.5-0.9). */
    static RUNNING_RPM_MIN = 300;

    static _state = null;
    static _loaded = false;
    static _lastConfirmPromptAt = 0;

    static _load() {
        if (FuelTankState._loaded) return;
        FuelTankState._loaded = true;
        try {
            const raw = localStorage.getItem(FuelTankState.STORAGE_KEY);
            FuelTankState._state = raw ? JSON.parse(raw) : null;
        } catch (_) {
            FuelTankState._state = null;
        }
        FuelTankState._checkStaleness();
    }

    /** Re-evaluate staleness against the current clock. Called on every getState()/needsConfirmation(),
     *  not just once per page load, so a silent mid-session data gap is caught. */
    static _checkStaleness() {
        if (FuelTankState._state && !FuelTankState._state.requires_confirm) {
            const lastMs = FuelTankState._state.last_sample_at
                ? new Date(FuelTankState._state.last_sample_at).getTime()
                : 0;
            if (lastMs && (Date.now() - lastMs) > FuelTankState.STALE_MS) {
                FuelTankState._state.requires_confirm = true;
                FuelTankState._save();
            }
        }
    }

    static _save() {
        try {
            localStorage.setItem(FuelTankState.STORAGE_KEY, JSON.stringify(FuelTankState._state));
        } catch (_) {}
    }

    static _fire() {
        window.dispatchEvent(new CustomEvent('fueltankstate:changed'));
    }

    /**
     * Configured per-tank capacity from aircraft-config.json (via CockpitConfig),
     * or `fallback` if unavailable/invalid. Single source for this lookup — shared
     * by init()'s clamp and any caller needing a fat-finger/plausibility ceiling —
     * so a future change to the capacity config path updates every caller at once.
     * @param {number} fallback - value to use when config is unavailable
     */
    static perSideCapGal(fallback) {
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) return cap / 2;
            }
        } catch (_) { /* fall through to caller's fallback */ }
        return fallback;
    }

    /**
     * Initialize with preflight fuel quantities. Clears requires_confirm.
     * @param {number} leftGal
     * @param {number} rightGal
     * @param {'L'|'R'} activeTank - this airframe has no BOTH selector position
     */
    static init(leftGal, rightGal, activeTank = 'L') {
        const now = new Date().toISOString();
        // This aircraft draws from one tank at a time — there is no BOTH position on the
        // selector. A legacy 'BOTH' (or anything else) is not a tank we can integrate
        // against, so fall back to L and make the pilot confirm rather than guessing.
        const validTank = (activeTank === 'L' || activeTank === 'R');
        FuelTankState._lastConfirmPromptAt = Date.now();
        const perSideCap = FuelTankState.perSideCapGal(Infinity);
        FuelTankState._state = {
            left_gal: Math.min(perSideCap, Math.max(0, leftGal)),
            right_gal: Math.min(perSideCap, Math.max(0, rightGal)),
            active_tank: validTank ? activeTank : 'L',
            tank_switched_at: now,
            last_sample_at: now,
            requires_confirm: !validTank,
            initialized_at: now,
            imbalance: false,
            dropped_burn_estimate_gal: 0,
            dropped_burn_ambiguous: false,
            // Gallons burned since this init() (tic measurement / fuel stop): the ENG
            // page USED gauge. State stored before this field existed has no such
            // field; it is left absent (read as null, shown '—') rather than counted
            // from 0, which would understate the burn.
            burned_since_init_gal: 0,
            // Gallons of pilot-applied dropped-burn corrections since this init()
            // (applyDroppedBurn). They lower the tanks but are an estimate, not
            // measured flow, so the K-factor calculator subtracts them out of the
            // tracked burn. Absent in state stored before the field existed.
            dropped_applied_since_init_gal: 0,
            // Set by markFlowLost() when fuel-flow data stops or freezes while the
            // engine is running: burn is no longer integrated, so the figure reads
            // high from that moment. Cleared by the next integrated sample (onSample)
            // or a fresh init(). needsConfirmation() is true while it is set.
            flow_lost_at: null,
            // Time of the last sample that actually integrated burn (onSample only;
            // init() and markConfirmed() do not set it, unlike last_sample_at).
            // Null here also means "no previous burning sample": the first sample
            // after init() books no comms gap (onSample), so the time between a tic
            // and engine start is never offered as dropped burn.
            last_burn_at: null,
            // Set by noteEngineStopped() when a current frame shows the engine
            // stopped (RPM <= RUNNING_RPM_MIN). While set, a gap before the next
            // sample is engine-off time, not dropped burn. Cleared by the next
            // sample with the engine running (onSample). Absent in older state.
            engine_stopped_at: null,
            // Gallons of comms-gap burn estimated since this init(): every amount
            // onSample() added to dropped_burn_estimate_gal, applied or not. The
            // K-factor calculator excludes a leg with a real gap (that burn is in the
            // tic difference but not in the flow burn). Absent in older state.
            gap_burn_since_init_gal: 0,
        };
        FuelTankState._loaded = true;
        FuelTankState._save();
        FuelTankState._fire();
    }

    /**
     * Process one engine data sample. Integrates fuel flow against active tank.
     * A gap longer than MAX_SAMPLE_DT_MS since last_sample_at integrates only the
     * capped dt; the rest is added to dropped_burn_estimate_gal (the pilot's
     * APPLY CORRECTION prompt) ONLY when the engine was burning at the last
     * integrated sample (last_burn_at set — never right after init()) and no engine
     * stop was seen since (engine_stopped_at null). Otherwise the gap was engine-off
     * time and books nothing.
     * @param {number} gph - Fuel flow in gallons per hour (must be > 0)
     * @param {number} nowMs - Current timestamp (Date.now())
     * @param {number} [rpm] - RPM of this frame. A finite RPM <= RUNNING_RPM_MIN
     *   (residual flow on a stopped engine) integrates as before but does not clear
     *   engine_stopped_at; any other value (incl. missing) clears it.
     */
    static onSample(gph, nowMs, rpm) {
        FuelTankState._load();
        if (!FuelTankState._state || FuelTankState._state.requires_confirm) return;
        if (!gph || gph <= 0) return;

        const lastMs = FuelTankState._state.last_sample_at
            ? new Date(FuelTankState._state.last_sample_at).getTime()
            : nowMs;
        const rawDtMs = nowMs - lastMs;
        const dtMs = Math.min(rawDtMs, FuelTankState.MAX_SAMPLE_DT_MS);
        if (dtMs <= 0) return;

        const droppedMs = rawDtMs - dtMs;
        const gapWasBurning = !!FuelTankState._state.last_burn_at && !FuelTankState._state.engine_stopped_at;
        if (droppedMs > 0 && gapWasBurning) {
            const droppedGal = gph * (droppedMs / 1000) / 3600;
            FuelTankState._state.dropped_burn_estimate_gal =
                (FuelTankState._state.dropped_burn_estimate_gal || 0) + droppedGal;
            if (typeof FuelTankState._state.gap_burn_since_init_gal === 'number') {
                FuelTankState._state.gap_burn_since_init_gal += droppedGal;
            }
        }

        const burned = gph * (dtMs / 1000) / 3600;

        // If the pilot switched tanks since the last sample, split this interval's
        // burn at the switch point instead of crediting it all to whichever tank is
        // active now — otherwise burn actually drawn from the tank just left, before
        // the switch, is never subtracted from it.
        const switchMs = FuelTankState._state.tank_switched_at
            ? new Date(FuelTankState._state.tank_switched_at).getTime()
            : null;
        const preSwitchTank = FuelTankState._state.pre_switch_tank;
        FuelTankState._state.pre_switch_tank = null; // consume regardless of outcome below

        if (preSwitchTank && switchMs !== null && switchMs > lastMs && switchMs < nowMs) {
            const preFraction = (switchMs - lastMs) / rawDtMs;
            const burnedPre = burned * preFraction;
            const burnedPost = burned - burnedPre;
            if (!FuelTankState._debitTank(preSwitchTank, burnedPre)) return;
            if (!FuelTankState._debitActiveTank(burnedPost)) return;
        } else {
            if (!FuelTankState._debitActiveTank(burned)) return;
        }

        FuelTankState._state.last_sample_at = new Date(nowMs).toISOString();
        FuelTankState._state.last_burn_at = FuelTankState._state.last_sample_at;
        // Flow is integrating again. Any burn during the gap was recorded above as
        // dropped_burn_estimate_gal (the pilot's dropped-burn correction).
        FuelTankState._state.flow_lost_at = null;
        if (!FuelTankState._isStoppedRpm(rpm)) FuelTankState._state.engine_stopped_at = null;

        const diff = Math.abs(FuelTankState._state.left_gal - FuelTankState._state.right_gal);
        FuelTankState._state.imbalance = (
            diff > FuelTankState.IMBALANCE_GAL &&
            FuelTankState._state.left_gal > 2 &&
            FuelTankState._state.right_gal > 2
        );

        FuelTankState._save();
        FuelTankState._fire();

        // Periodic confirmation prompt while engine is running
        if ((nowMs - FuelTankState._lastConfirmPromptAt) > FuelTankState.CONFIRM_INTERVAL_MS) {
            FuelTankState._lastConfirmPromptAt = nowMs;
            window.dispatchEvent(new CustomEvent('fueltankstate:confirm_prompt', {
                detail: { active_tank: FuelTankState._state.active_tank }
            }));
        }
    }

    /**
     * Debit `gallons` from a specific tank ('L' or 'R'). An invalid tank (legacy
     * 'BOTH' state, or corruption) tells us nothing about which tank is draining;
     * splitting the burn would understate the feeding tank, so this stops and
     * flags requires_confirm instead of guessing.
     * @param {'L'|'R'} tank
     * @param {number} gallons
     * @returns {boolean} true if the debit was applied
     */
    static _debitTank(tank, gallons) {
        if (tank === 'L' || tank === 'R') {
            const st = FuelTankState._state;
            if (typeof st.burned_since_init_gal === 'number') st.burned_since_init_gal += gallons;
        }
        if (tank === 'L') {
            FuelTankState._state.left_gal = Math.max(0, FuelTankState._state.left_gal - gallons);
            return true;
        } else if (tank === 'R') {
            FuelTankState._state.right_gal = Math.max(0, FuelTankState._state.right_gal - gallons);
            return true;
        }
        FuelTankState._state.requires_confirm = true;
        FuelTankState._save();
        FuelTankState._fire();
        return false;
    }

    /**
     * Debit `gallons` from whichever tank is active. Shared by onSample() and
     * applyDroppedBurn() so the two burn-accounting paths can't drift apart.
     * @param {number} gallons
     * @returns {boolean} true if the debit was applied
     */
    static _debitActiveTank(gallons) {
        return FuelTankState._debitTank(FuelTankState._state.active_tank, gallons);
    }

    /**
     * Switch the active fuel tank.
     * @param {'L'|'R'} tank - this airframe has no BOTH selector position
     */
    static switchTank(tank) {
        FuelTankState._load();
        if (!FuelTankState._state) return;
        if (tank !== 'L' && tank !== 'R') return;   // no BOTH on this aircraft
        const prevTank = FuelTankState._state.active_tank;
        if ((prevTank === 'L' || prevTank === 'R') && prevTank !== tank) {
            FuelTankState._state.pre_switch_tank = prevTank;
            FuelTankState._state.tank_switched_at = new Date().toISOString();
            // A comms-gap correction accrued while feeding from prevTank has no record of
            // which tank was active for each contributing gap — dropped_burn_estimate_gal
            // is one running total, not a per-tank breakdown. Once the pilot has moved to
            // a different tank it can no longer be safely auto-attributed to either one.
            // Same "stop and ask, don't guess" rule as an invalid active_tank; clears on
            // the next fresh measurement via init().
            if ((FuelTankState._state.dropped_burn_estimate_gal || 0) > 0.05) {
                FuelTankState._state.dropped_burn_ambiguous = true;
            }
        }
        FuelTankState._state.active_tank = tank;
        FuelTankState._save();
        FuelTankState._fire();
    }

    /**
     * Apply a pilot-confirmed correction for fuel burned during a comms gap
     * (tracked in dropped_burn_estimate_gal by onSample() but never auto-applied —
     * the gap-time estimate extrapolates from whatever GPH arrived right after the
     * gap, which may not represent what was actually happening during it, so this
     * requires the pilot to review/edit the amount before it touches the gauge).
     * Subtracts from the active tank and reduces the outstanding estimate by the
     * same amount; does not touch the inactive tank. Refuses while
     * requires_confirm is set — same rationale as onSample(): a stale or
     * unconfirmed tank selection means we can't safely say which tank to charge.
     * requires_confirm can also become true as a SIDE EFFECT of this very call
     * (an invalid active_tank caught by _debitActiveTank()), so callers must
     * check the return value rather than assuming a call that didn't throw
     * actually applied anything.
     * @param {number} gallons - pilot-confirmed (or edited) correction amount
     * @returns {boolean} true if the correction was actually applied
     */
    static applyDroppedBurn(gallons) {
        FuelTankState._load();
        if (!FuelTankState._state || FuelTankState._state.requires_confirm || !(gallons > 0)) return false;
        if (FuelTankState._state.dropped_burn_ambiguous) return false;
        if (!FuelTankState._debitActiveTank(gallons)) return false;
        if (typeof FuelTankState._state.dropped_applied_since_init_gal === 'number') {
            FuelTankState._state.dropped_applied_since_init_gal += gallons;
        }
        FuelTankState._state.dropped_burn_estimate_gal =
            Math.max(0, (FuelTankState._state.dropped_burn_estimate_gal || 0) - gallons);
        FuelTankState._save();
        FuelTankState._fire();
        return true;
    }

    /** True if a tank switch occurred while a comms-gap correction was still
     *  outstanding, making it unsafe to auto-attribute to either tank. Clears
     *  on the next init() (fresh tic measurement or fuel stop). */
    static isDroppedBurnAmbiguous() {
        FuelTankState._load();
        return !!(FuelTankState._state && FuelTankState._state.dropped_burn_ambiguous);
    }

    /**
     * Fuel-flow data stopped (engine:stale / engine:disconnect) or froze (a frame
     * that is not EngineClient.edmCurrent). If the engine was running, the tracked
     * figure stops falling while fuel still burns, so it is marked at once
     * (flow_lost_at → needsConfirmation() true) instead of 45 min later (STALE_MS).
     * The engine counts as running when the last CURRENT frame this session had
     * GPH > 0 and RPM > RUNNING_RPM_MIN, or — with no current frame seen yet this
     * session (`lastCurrentGph` null: app restarted with the data already frozen) —
     * when burn was integrated within RECENT_BURN_MS. Engine off on the ground (last
     * current GPH 0 or RPM ≤ 300, or nothing integrated recently) is not marked.
     * @param {number} nowMs
     * @param {number|null} lastCurrentGph - GPH of the last current frame, null if none
     * @param {number} [lastCurrentRpm] - RPM of that frame (missing → not running)
     * @returns {boolean} true if the state is (now) marked flow-lost
     */
    static markFlowLost(nowMs, lastCurrentGph, lastCurrentRpm) {
        FuelTankState._load();
        const st = FuelTankState._state;
        if (!st) return false;
        if (st.flow_lost_at) return true;
        let running = lastCurrentGph > 0 && lastCurrentRpm > FuelTankState.RUNNING_RPM_MIN;
        if (!running && lastCurrentGph == null && st.last_burn_at) {
            const burnMs = new Date(st.last_burn_at).getTime();
            running = Number.isFinite(burnMs) && (nowMs - burnMs) >= 0 &&
                (nowMs - burnMs) <= FuelTankState.RECENT_BURN_MS;
        }
        if (!running) return false;
        st.flow_lost_at = new Date(nowMs).toISOString();
        FuelTankState._save();
        FuelTankState._fire();
        return true;
    }

    /** A finite RPM at or below RUNNING_RPM_MIN: the engine is stopped. */
    static _isStoppedRpm(rpm) {
        return typeof rpm === 'number' && Number.isFinite(rpm) && rpm <= FuelTankState.RUNNING_RPM_MIN;
    }

    /**
     * A CURRENT engine frame shows the engine stopped (RPM <= RUNNING_RPM_MIN, even
     * with residual fuel flow). Sets engine_stopped_at, so a gap before the next
     * sample is not booked as dropped burn (onSample); the next sample with the
     * engine running clears it.
     *
     * Exception — a stop seen right after an unobserved stretch that began with the
     * engine burning does not cancel that stretch: the engine may have run for most
     * of it (landed and shut down during a data outage, or the app was closed in
     * flight). That is: burn was integrated (last_burn_at), no stop was seen, and
     * there was no current frame for more than MAX_SAMPLE_DT_MS before this one
     * (`prevFrameMs`, the previous current frame this app session; null after an app
     * start, when last_sample_at is used instead). Then the figure is marked
     * flow-lost (UNCONFIRMED; already so after a data outage with the engine
     * running) and engine_stopped_at stays null, so the stretch is booked as dropped
     * burn at the next sample (an over-estimate that includes engine-off time; the
     * pilot reviews it before applying). While flow_lost_at is set, no stop is noted.
     * @param {number} nowMs
     * @param {number|null} prevFrameMs - time of the previous current frame, null if none
     * @returns {boolean} true if the state now holds a stop (engine_stopped_at)
     */
    static noteEngineStopped(nowMs, prevFrameMs) {
        FuelTankState._load();
        const st = FuelTankState._state;
        if (!st) return false;
        if (st.flow_lost_at) return false;
        if (st.engine_stopped_at) return true;
        if (st.last_burn_at) {
            const refMs = Number.isFinite(prevFrameMs) ? prevFrameMs
                : (st.last_sample_at ? new Date(st.last_sample_at).getTime() : NaN);
            if (!(nowMs - refMs <= FuelTankState.MAX_SAMPLE_DT_MS)) {
                st.flow_lost_at = new Date(nowMs).toISOString();
                FuelTankState._save();
                FuelTankState._fire();
                return false;
            }
        }
        st.engine_stopped_at = new Date(nowMs).toISOString();
        FuelTankState._save();
        return true;
    }

    /** True while fuel-flow data is lost with the engine running (markFlowLost). */
    static isFlowLost() {
        FuelTankState._load();
        return !!(FuelTankState._state && FuelTankState._state.flow_lost_at);
    }

    /** Returns a copy of current state, or null if not initialized. */
    static getState() {
        FuelTankState._load();
        FuelTankState._checkStaleness();
        return FuelTankState._state ? { ...FuelTankState._state } : null;
    }

    /**
     * True if pilot confirmation is required before trusting state.
     * True when: no state exists, requires_confirm flag is set, the last sample is
     * stale (STALE_MS), or fuel-flow data is lost with the engine running
     * (flow_lost_at, markFlowLost). Only requires_confirm stops burn integration;
     * flow_lost_at clears itself on the next integrated sample.
     */
    static needsConfirmation() {
        FuelTankState._load();
        FuelTankState._checkStaleness();
        if (!FuelTankState._state) return true;
        return !!FuelTankState._state.requires_confirm || !!FuelTankState._state.flow_lost_at;
    }

    /** Pilot has confirmed the current state is accurate. */
    static markConfirmed() {
        // Deliberately leaves flow_lost_at alone: this confirms the tank SELECTION
        // ("Still on LEFT tank?" YES, also auto-fired after 60 s), not the quantity.
        // Lost-flow marking clears only on the next integrated sample or init().
        FuelTankState._load();
        if (!FuelTankState._state) return;
        FuelTankState._state.requires_confirm = false;
        FuelTankState._state.last_sample_at = new Date().toISOString();
        FuelTankState._save();
        FuelTankState._fire();
    }
}
