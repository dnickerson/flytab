#!/usr/bin/env python3
"""One-off generator: run the offline detect_phases() over the shared
parity fixture and freeze its output as JSON for the JS golden-parity
test. Re-run and re-commit the output whenever phase_spec.json or
detect_phases() changes in ~/engine_analysis.

Usage: python3 tools/freeze_phase_parity_fixture.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / 'engine_analysis'))
import pandas as pd
from train_anomaly_model import detect_phases

FIXTURE = Path(__file__).parent.parent / 'tests/phase-detection/fixtures/20260710_KLKR-KLKR_parity.csv'
OUTPUT = Path(__file__).parent.parent / 'tests/phase-detection/fixtures/20260710_KLKR-KLKR_parity.json'

df = pd.read_csv(FIXTURE)
phases = detect_phases(df).tolist()

OUTPUT.write_text(json.dumps({'phases': phases}, indent=2))
print(f"Wrote {len(phases)} phase labels to {OUTPUT}")
