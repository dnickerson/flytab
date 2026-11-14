package app.flywhere.flytab.engineml;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.junit.Test;

/**
 * Fuel follow-up F4: EngineAdvisor used to read fuel_remaining 0 as "unknown" and
 * fall back to TANK_CAPACITY_GAL (full tanks), so real empty tanks read as full.
 * JS now sends -1 for unknown (nothing tracked, capacity default only, stale) and
 * a measured figure (incl. 0.0) as itself. Unknown → the route advisory is skipped;
 * 0 → "Insufficient fuel". A missing payload field is also unknown.
 */
public class EngineAdvisorFuelRemainingTest {
    // RPM, EGT1-4, CHT1-4, OilTemp, OilPress, FuelFlow (8.1 GPH)
    private static final float[] CRUISE = { 2400, 1350, 1360, 1340, 1355, 360, 365, 358, 362, 185, 78, 8.1f };

    /** advise() in cruise with a route: 100 NM at 140 kt (≈5.8 gal at 8.1 GPH). */
    private static List<EngineAdvisor.Advisory> routeAdvice(EngineAdvisor a) {
        return routeAdvice(a, 100f);
    }

    private static List<EngineAdvisor.Advisory> routeAdvice(EngineAdvisor a, float distNm) {
        return a.advise(CRUISE, "cruise", 0f, false, distNm, 140f, false);
    }

    private static EngineAdvisor withFuel(float fuelRemaining) {
        EngineAdvisor a = new EngineAdvisor();
        a.addSample(CRUISE, "cruise", 22.5f, 0f, fuelRemaining, 5500f);
        return a;
    }

    private static boolean hasRoute(List<EngineAdvisor.Advisory> l) {
        for (EngineAdvisor.Advisory adv : l) if ("route".equals(adv.category)) return true;
        return false;
    }

    private static boolean has(List<EngineAdvisor.Advisory> l, String text) {
        for (EngineAdvisor.Advisory adv : l) if (adv.message.contains(text)) return true;
        return false;
    }

    @Test
    public void unknownFuelSkipsTheRouteAdvisory() {
        // 600 NM (≈34.7 gal): the old 36-gal fallback produced a reserve warning here.
        assertFalse(hasRoute(routeAdvice(withFuel(-1f), 600f)));
        assertFalse(hasRoute(routeAdvice(withFuel(-1f))));
    }

    @Test
    public void realZeroFuelIsInsufficientNotFullTanks() {
        List<EngineAdvisor.Advisory> out = routeAdvice(withFuel(0f));
        assertTrue(has(out, "Insufficient fuel"));
        assertTrue(has(out, "have 0.0 gal"));
    }

    @Test
    public void measuredFuelIsUsedAsIs() {
        // 6.5 gal for ≈5.8 gal needed: reserve ≈0.7 gal, below the 1 h minimum.
        List<EngineAdvisor.Advisory> out = routeAdvice(withFuel(6.5f));
        assertTrue(has(out, "reserve at dest"));
        assertFalse(has(out, "Insufficient fuel"));
    }

    @Test
    public void noSampleYetAndAfterResetFuelIsUnknown() {
        EngineAdvisor fresh = new EngineAdvisor();
        assertFalse(hasRoute(routeAdvice(fresh, 600f)));

        EngineAdvisor a = withFuel(20f);
        a.reset();
        assertFalse(hasRoute(routeAdvice(a, 600f)));
    }

    @Test
    public void payloadParsingMissingOrNonNumericIsUnknown() {
        assertEquals(-1f, EngineAdvisor.fuelRemainingFromPayload(null), 0f);
        assertEquals(-1f, EngineAdvisor.fuelRemainingFromPayload(Double.NaN), 0f);
        assertEquals(-1f, EngineAdvisor.fuelRemainingFromPayload(Double.POSITIVE_INFINITY), 0f);
        assertEquals(-1f, EngineAdvisor.fuelRemainingFromPayload(-1.0), 0f);
        assertEquals(-1f, EngineAdvisor.fuelRemainingFromPayload(-0.5), 0f);
        assertEquals(0f, EngineAdvisor.fuelRemainingFromPayload(0.0), 0f);
        assertEquals(12.5f, EngineAdvisor.fuelRemainingFromPayload(12.5), 0f);
    }
}
