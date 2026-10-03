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
        };
        FuelTankState._loaded = true;
        FuelTankState._save();
        FuelTankState._fire();
    }

    /**
     * Process one engine data sample. Integrates fuel flow against active tank.
     * @param {number} gph - Fuel flow in gallons per hour (must be > 0)
     * @param {number} nowMs - Current timestamp (Date.now())
     */
    static onSample(gph, nowMs) {
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
        if (droppedMs > 0) {
            const droppedGal = gph * (droppedMs / 1000) / 3600;
            FuelTankState._state.dropped_burn_estimate_gal =
                (FuelTankState._state.dropped_burn_estimate_gal || 0) + droppedGal;
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

    /** Returns a copy of current state, or null if not initialized. */
    static getState() {
        FuelTankState._load();
        FuelTankState._checkStaleness();
        return FuelTankState._state ? { ...FuelTankState._state } : null;
    }

    /**
     * True if pilot confirmation is required before trusting state.
     * True when: no state exists, requires_confirm flag is set, or last sample is stale.
     */
    static needsConfirmation() {
        FuelTankState._load();
        FuelTankState._checkStaleness();
        if (!FuelTankState._state) return true;
        return !!FuelTankState._state.requires_confirm;
    }

    /** Pilot has confirmed the current state is accurate. */
    static markConfirmed() {
        FuelTankState._load();
        if (!FuelTankState._state) return;
        FuelTankState._state.requires_confirm = false;
        FuelTankState._state.last_sample_at = new Date().toISOString();
        FuelTankState._save();
        FuelTankState._fire();
    }
}
