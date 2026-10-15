package app.flywhere.flytab.engineml;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.junit.Test;

/**
 * PR A review (A9): EngineAdvisor's rule-based advisories (trends, correlated
 * alerts, lead fouling, mixture, carb ice) must not depend on the ML score.
 * EngineMLPlugin used to call advise() only after a successful inference, so
 * while ML was busy, timed out or disabled they were silently off. With no ML
 * score, advise() must still run the rules, but must not add the "all normal"
 * fallback line (that would read as ML saying the engine is fine).
 */
public class EngineAdvisorNoMlTest {
    // RPM, EGT1-4, CHT1-4, OilTemp, OilPress, FuelFlow
    private static final float[] CRUISE = { 2400, 1350, 1360, 1340, 1355, 360, 365, 358, 362, 185, 78, 8.1f };

    private static EngineAdvisor advisorWithCarbTemp(float carbTempF) {
        EngineAdvisor a = new EngineAdvisor();
        a.addSample(CRUISE, "cruise", 22.5f, carbTempF, 30f, 5500f);
        return a;
    }

    private static boolean has(List<EngineAdvisor.Advisory> l, String text) {
        for (EngineAdvisor.Advisory adv : l) if (adv.message.contains(text)) return true;
        return false;
    }

    @Test
    public void carbIceIsReportedWithoutAnMlScore() {
        List<EngineAdvisor.Advisory> out = advisorWithCarbTemp(50f).advise(CRUISE, "cruise", 0f, false, 0f, 140f, false);
        assertTrue(has(out, "carb ice"));
    }

    @Test
    public void noMlScoreMeansNoAllNormalLine() {
        // A quiet taxi sample: no rule fires, so only the fallback line could appear.
        EngineAdvisor a = new EngineAdvisor();
        float[] taxi = { 1000, 1100, 1110, 1090, 1105, 300, 305, 298, 302, 160, 70, 3.0f };
        a.addSample(taxi, "taxi_out", 0f, 0f, 30f, 600f);
        assertEquals(0, a.advise(taxi, "taxi_out", 0f, false, 0f, 10f, false).size());
        // With an ML score, the same sample gets exactly the one normal line.
        List<EngineAdvisor.Advisory> scored = a.advise(taxi, "taxi_out", 0.01f, false, 0f, 10f);
        assertEquals(1, scored.size());
        assertEquals(EngineAdvisor.SEVERITY_INFO, scored.get(0).severity);
    }
}
