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
        // Mark stale if app restarted mid-flight
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
     * Initialize with preflight fuel quantities. Clears requires_confirm.
     * @param {number} leftGal
     * @param {number} rightGal
     * @param {'L'|'R'|'BOTH'} activeTank
     */
    static init(leftGal, rightGal, activeTank = 'L') {
        const now = new Date().toISOString();
        FuelTankState._state = {
            left_gal: Math.max(0, leftGal),
            right_gal: Math.max(0, rightGal),
            active_tank: activeTank,
            tank_switched_at: now,
            last_sample_at: now,
            requires_confirm: false,
            initialized_at: now,
            imbalance: false,
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
        const dtMs = Math.min(nowMs - lastMs, FuelTankState.MAX_SAMPLE_DT_MS);
        if (dtMs <= 0) return;

        const burned = gph * (dtMs / 1000) / 3600;

        if (FuelTankState._state.active_tank === 'L') {
            FuelTankState._state.left_gal = Math.max(0, FuelTankState._state.left_gal - burned);
        } else if (FuelTankState._state.active_tank === 'R') {
            FuelTankState._state.right_gal = Math.max(0, FuelTankState._state.right_gal - burned);
        } else {
            // BOTH: split evenly
            FuelTankState._state.left_gal = Math.max(0, FuelTankState._state.left_gal - burned / 2);
            FuelTankState._state.right_gal = Math.max(0, FuelTankState._state.right_gal - burned / 2);
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
     * Switch the active fuel tank.
     * @param {'L'|'R'|'BOTH'} tank
     */
    static switchTank(tank) {
        FuelTankState._load();
        if (!FuelTankState._state) return;
        FuelTankState._state.active_tank = tank;
        FuelTankState._state.tank_switched_at = new Date().toISOString();
        FuelTankState._save();
        FuelTankState._fire();
    }

    /**
     * Add fuel to a specific tank (fuel stop).
     * @param {'L'|'R'} tank
     * @param {number} gallons
     */
    static topOff(tank, gallons) {
        FuelTankState._load();
        if (!FuelTankState._state || gallons <= 0) return;
        if (tank === 'L') {
            FuelTankState._state.left_gal = Math.max(0, FuelTankState._state.left_gal + gallons);
        } else if (tank === 'R') {
            FuelTankState._state.right_gal = Math.max(0, FuelTankState._state.right_gal + gallons);
        }
        FuelTankState._save();
        FuelTankState._fire();
    }

    /** Returns a copy of current state, or null if not initialized. */
    static getState() {
        FuelTankState._load();
        return FuelTankState._state ? { ...FuelTankState._state } : null;
    }

    /**
     * True if pilot confirmation is required before trusting state.
     * True when: no state exists, requires_confirm flag is set, or last sample is stale.
     */
    static needsConfirmation() {
        FuelTankState._load();
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
