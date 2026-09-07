"""
Regression coverage for FuelTracker's dropped-burn gap handling and correction
(PR #143). Uses stdlib unittest only — no new dependency, runnable anywhere
Python 3 runs: `python3 -m unittest engine-monitor/test_fuel_tracker.py` from
the repo root, or `python3 test_fuel_tracker.py` from this directory.

This is flight-safety-relevant code (fuel_remaining accuracy) with no prior
committed regression coverage — see PR #143 review.
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine_monitor as em


class FuelTrackerGapHandlingTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.ft = em.FuelTracker(self.tmpdir)
        self.ft.fuel_remaining = 20.0

    def test_normal_sample_integrates_fully_no_drop(self):
        self.ft.update(fuel_flow=9.0, edm_timestamp=1000.0, ground_speed=100, rpm=2400, mp=22)
        self.ft.update(fuel_flow=9.0, edm_timestamp=1005.0, ground_speed=100, rpm=2400, mp=22)  # +5s
        expected_burn = 9.0 * (5.0 / 3600.0)
        self.assertAlmostEqual(self.ft.fuel_remaining, 20.0 - expected_burn, places=9)
        self.assertEqual(self.ft.dropped_burn_estimate_gal, 0.0)

    def test_long_gap_caps_integration_and_tracks_the_excess(self):
        self.ft.update(fuel_flow=9.0, edm_timestamp=1000.0, ground_speed=100, rpm=2400, mp=22)
        self.ft.update(fuel_flow=9.0, edm_timestamp=1130.0, ground_speed=100, rpm=2400, mp=22)  # +130s gap
        integrated = 9.0 * (self.ft.MAX_SAMPLE_GAP_HOURS)   # 10s worth
        dropped = 9.0 * (120.0 / 3600.0)                     # 120s worth
        self.assertAlmostEqual(self.ft.fuel_remaining, 20.0 - integrated, places=9)
        self.assertAlmostEqual(self.ft.dropped_burn_estimate_gal, dropped, places=9)

    def test_apply_dropped_burn_debits_and_reduces_estimate_by_same_amount(self):
        self.ft.dropped_burn_estimate_gal = 2.14
        self.ft.apply_dropped_burn(1.7)  # e.g. a pilot-edited amount, less than the full estimate
        self.assertAlmostEqual(self.ft.fuel_remaining, 20.0 - 1.7, places=9)
        self.assertAlmostEqual(self.ft.dropped_burn_estimate_gal, 0.44, places=9)

    def test_apply_dropped_burn_is_a_noop_for_non_positive_gallons(self):
        self.ft.dropped_burn_estimate_gal = 1.0
        self.ft.apply_dropped_burn(0)
        self.ft.apply_dropped_burn(-5)
        self.assertEqual(self.ft.fuel_remaining, 20.0)
        self.assertEqual(self.ft.dropped_burn_estimate_gal, 1.0)

    def test_apply_own_dropped_burn_applies_its_own_current_estimate_and_returns_it(self):
        self.ft.dropped_burn_estimate_gal = 1.23
        applied = self.ft.apply_own_dropped_burn()
        self.assertAlmostEqual(applied, 1.23, places=9)
        self.assertAlmostEqual(self.ft.fuel_remaining, 20.0 - 1.23, places=9)
        self.assertEqual(self.ft.dropped_burn_estimate_gal, 0.0)

    def test_apply_own_dropped_burn_ignores_a_stale_snapshot_read_before_it(self):
        # Regression for the race PR #143's second review found: reading
        # dropped_burn_estimate_gal separately from applying it could report/apply
        # a stale value if update() (capture thread) mutated it in between. Here we
        # simulate "someone captured an old estimate" and confirm apply_own_dropped_burn()
        # always uses its OWN fresh read, not a value handed to it.
        self.ft.dropped_burn_estimate_gal = 1.0
        stale_snapshot = self.ft.dropped_burn_estimate_gal  # e.g. read by another thread earlier
        self.ft.dropped_burn_estimate_gal = 5.0             # update() ran again in between
        applied = self.ft.apply_own_dropped_burn()
        self.assertNotEqual(applied, stale_snapshot)
        self.assertAlmostEqual(applied, 5.0, places=9)
        self.assertAlmostEqual(self.ft.fuel_remaining, 20.0 - 5.0, places=9)

    def test_apply_own_dropped_burn_is_a_noop_and_returns_zero_when_nothing_tracked(self):
        self.assertEqual(self.ft.dropped_burn_estimate_gal, 0.0)
        applied = self.ft.apply_own_dropped_burn()
        self.assertEqual(applied, 0.0)
        self.assertEqual(self.ft.fuel_remaining, 20.0)

    def test_dropped_burn_estimate_persists_across_a_restart(self):
        self.ft.dropped_burn_estimate_gal = 3.21
        self.ft._save_state()
        reloaded = em.FuelTracker(self.tmpdir)
        self.assertAlmostEqual(reloaded.dropped_burn_estimate_gal, 3.21, places=9)

    def test_set_fuel_clears_outstanding_dropped_burn_debt(self):
        # A fresh ground-truth reading (tic mark, fuel stop) supersedes whatever
        # gap happened before it. Without this, applying a correction afterward
        # would double-subtract fuel the fresh total already accounted for.
        self.ft.dropped_burn_estimate_gal = 2.5
        self.ft.set_fuel(15.0, reason='tic mark measurement')
        self.assertEqual(self.ft.dropped_burn_estimate_gal, 0.0)
        self.assertEqual(self.ft.fuel_remaining, 15.0)

    def test_add_fuel_clears_outstanding_dropped_burn_debt(self):
        self.ft.dropped_burn_estimate_gal = 1.8
        self.ft.add_fuel(10.0, airport='KPAO')
        self.assertEqual(self.ft.dropped_burn_estimate_gal, 0.0)


if __name__ == '__main__':
    unittest.main()
