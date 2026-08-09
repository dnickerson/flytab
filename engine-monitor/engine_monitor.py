#!/usr/bin/env python3
"""
Engine Monitor Web Server
=========================
All-in-one solution for capturing, monitoring, and downloading engine data.
Designed for high-visibility on iPad in direct sunlight.

Features:
- Live dashboard with EGT, CHT, RPM, MP, Fuel Flow
- Start/Stop capture via web interface
- Download captured files
- Auto-rename files with GPS timestamp on stop
- High-contrast display for sunlight

Usage:
    python3 engine_monitor.py

Access at: http://stratux.local:8080
"""

VERSION = "3.4.0"

# Contract version for the payload shape and shared physical constants FlyTab
# depends on (field names, nesting, units, usable_capacity_gal and similar).
# Bump this when any of those change — NOT for ordinary bug fixes. VERSION is
# for humans; this is what client code compares. Starts at 2 because the
# 2026-08-01 fuel-management work already changed the contract once, silently
# (usable_capacity_gal 34->36, flight_fuel_used moved under 'fuel') — this
# value retroactively names that shape "2" so a Pi that has not been
# redeployed since then correctly reports as behind. See issue #113.
PI_API_CONTRACT = 2

# Optional features this build of engine_monitor.py supports, independent of
# api_contract — a client can check `'fuel_tracker' in capabilities` rather
# than inferring feature support from a version/contract number comparison.
PI_CAPABILITIES = ["fuel_tracker", "sticky_valve", "peak_egt"]

import os
import sys
import json
import time
import threading
import signal
import itertools
import math
import socket
import xml.etree.ElementTree as ET
from datetime import datetime
from collections import deque
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
import glob
import uuid
import shutil
import hmac
import secrets

# Path to local Chart.js file (same directory as this script)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CHART_JS_PATH = os.path.join(SCRIPT_DIR, 'chart.min.js')

# Stratux integration uses HTTP API (no extra dependencies needed)

# Constants for calculations
HISTORY_SECONDS = 30 * 60  # 30 minutes of history
MAX_HISTORY_POINTS = 20000  # Max points to store (auto-pruned by time, not count)

# O-360-A1A Engine Constants
ENGINE_MAX_HP = 180  # Rated horsepower
ENGINE_RATED_RPM = 2700  # Rated RPM
ENGINE_RATED_MP = 29.0  # Full throttle MP at sea level
COMPRESSION_RATIO_FACTOR = 14.9  # HP = FF * factor for 8.5:1 compression (LOP only)
# SFC values converted from BSFC (lb/HP/hr) to GPH/HP by dividing by 6 (avgas density)
# BSFC at best power: ~0.50 lb/HP/hr → 0.50/6 = 0.083 GPH/HP
# BSFC at best economy: ~0.40 lb/HP/hr → 0.40/6 = 0.067 GPH/HP
BEST_POWER_SFC = 0.083  # GPH per HP at best power (ROP)
BEST_ECONOMY_SFC = 0.067  # GPH per HP at best economy (LOP)

# Fuel flow smoothing for carbureted float bowl lag (TIME-BASED)
FF_SMOOTHING_SECONDS = 3.0  # 3 second rolling average to smooth float bowl oscillations

# Sticky valve detection parameters (TIME-BASED)
STICKY_VALVE_WARMUP_MINUTES = 10  # Monitor for sticky valve during first 10 minutes
STICKY_VALVE_EGT_RATIO = 0.50  # Alert if one cylinder EGT < 50% of others' average
STICKY_VALVE_MIN_EGT = 200  # Minimum average EGT to consider engine "running" for detection
STICKY_VALVE_PERSIST_SECONDS = 30  # Must persist for 30 seconds to trigger alert

# Auto-detect environment (stratux hostname = aircraft, otherwise desktop)
_hostname = socket.gethostname()
_is_aircraft = _hostname in ('stratux', 'flypi')

# Configuration
CONFIG = {
    'SERIAL_PORT': '/dev/ttyUSB0',
    'BAUD_RATE': 115200,
    'DATA_DIR': '/opt/capture_v5' if _is_aircraft else os.path.expanduser('~/engine_data'),
    'WEB_PORT': 8080,
    'WEB_BIND': '0.0.0.0',  # Bind all interfaces — FlyPi serves over ap0 hotspot
    'ACTIVE_FILE': 'capture_active.txt',
    'ACTIVE_CSV': 'flight_active.csv',
    'LOG_FILE': 'engine_monitor.log',
    'STRATUX_HTTP_URL': 'http://localhost/getSituation',  # Stratux HTTP API (won't interfere with ForeFlight)
    'STRATUX_POLL_INTERVAL': 1.0,  # Seconds between HTTP polls
    # Auto-detection
    'IS_AIRCRAFT': _is_aircraft,
    'HOSTNAME': _hostname,
    # Playback mode (desktop testing)
    'PLAYBACK_MODE': False,
    'PLAYBACK_FILE': None,
    'PLAYBACK_RATE': 1.0,  # 1.0 = realtime, 10.0 = 10x speed
    'KML_FILE': None,
}

# Server-side CSV header (matches client format for compatibility)
CSV_HEADER = 'Zulu_Time,MP,Oil Temp,Oil Pressure,Fuel Pressure,Volts,Amps,RPM,Fuel Flow,Gallons Remaining,Fuel Level 1,Fuel Level 2,Carb Temp,GP 2,GP 3,Thermalcouple,EGT 1,EGT 2,EGT 3,EGT 4,CHT 1,CHT 2,CHT 3,CHT 4,date,time_z,longitude,latitude,altitude_ft,speed_kts,bank,pitch,acc_vert,course,EGT Spread,CHT Spread,Max EGT,Final_Percent_Power,Operating_Condition,Percent,SFC'

# Fuel tracking configuration
FUEL_CONFIG = {
    'capacity_gal': 36.0,           # Aircraft fuel capacity (2x 18 gal tanks) — canonical
    # DEPRECATED (2026-07-31, owner decision): the "usable capacity" concept is retired.
    # Capacity is 36 gal total / 18 per side everywhere, matching the canonical value in
    # web/aircraft-config.json (performance.fuel_capacity_gal), which the aircraft page
    # edits. This key is kept only so the emitted JSON keys below ('capacity' in
    # get_status(), 'usable_capacity' in fuel_data.json) keep their names; it is now just
    # an alias for capacity_gal and no new code should reference it.
    'usable_capacity_gal': 36.0,
    'low_fuel_warning_gal': 8.0,    # Yellow warning threshold
    'low_fuel_critical_gal': 4.0,   # Red warning threshold
    'min_endurance_minutes': 45,    # Endurance warning threshold
    'data_file': 'fuel_data.json',  # Persistent storage file
    'cruise_rpm_min': 2000,         # Minimum RPM to consider cruise
    'cruise_rpm_max': 2600,         # Maximum RPM to consider cruise
    'cruise_mp_min': 18,            # Minimum MP to consider cruise
    'cruise_mp_max': 26,            # Maximum MP to consider cruise
    'cruise_gs_min': 80,            # Minimum ground speed to consider cruise
    'k_factor_default': 68000,      # EI FT-60 Red Cube default K-factor
    'save_interval': 60,            # Save state every 60 seconds during operation
}

# Standard atmosphere constants
ISA_SEA_LEVEL_TEMP_C = 15.0  # Standard temp at sea level in Celsius
ISA_LAPSE_RATE = 0.00198  # °C per foot (approximately 2°C per 1000 ft)
ISA_SEA_LEVEL_PRESSURE = 29.92  # Standard pressure in inHg

# Field parsing from EDM format
FIELD_WIDTHS = [2, 2, 2, 2, 4, 3, 3, 3, 3, 3, 3, 3, 4, 3, 3, 8, 8, 8, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3]
FIELD_NAMES = ['hours', 'minutes', 'seconds', 'factor', 'MP', 'Oil_Temp', 'Oil_Press',
               'Fuel_Press', 'Volts', 'Amps', 'RPM', 'Fuel_Flow', 'Gallons_Rem',
               'Fuel_L1', 'Fuel_L2', 'Carb_Temp', 'GP2', 'GP3', 'Thermo',
               'EGT1', 'EGT2', 'EGT3', 'EGT4', 'DROP2', 'DROP3',
               'CHT1', 'CHT2', 'CHT3', 'CHT4', 'DROP4', 'DROP5']


class KFactorCalibration:
    """Tracks fuel flow sensor calibration data for EI FT-60 Red Cube."""

    def __init__(self):
        self.current_k_factor = FUEL_CONFIG['k_factor_default']
        self.period_start = None
        self.total_fuel_added = 0.0
        self.total_computed_used = 0.0
        self.calibration_history = []

    def start_period(self):
        """Begin new calibration period."""
        self.period_start = datetime.now().isoformat()
        self.total_fuel_added = 0.0
        self.total_computed_used = 0.0

    def record_fuel_addition(self, gallons):
        """Record actual fuel added from pump."""
        self.total_fuel_added += gallons

    def record_computed_usage(self, gallons):
        """Record computed fuel used from integration."""
        self.total_computed_used += gallons

    def get_calibration_status(self):
        """Return current calibration data and recommendation."""
        if self.total_fuel_added < 30:
            return {
                'ready': False,
                'message': f'Need more data: {self.total_fuel_added:.1f} gal added, recommend 30+ gal',
                'current_k_factor': self.current_k_factor,
                'period_start': self.period_start,
                'fuel_added': round(self.total_fuel_added, 1),
                'computed_used': round(self.total_computed_used, 1),
            }

        k_ratio = self.total_computed_used / self.total_fuel_added if self.total_fuel_added > 0 else 1.0
        suggested_k = round(self.current_k_factor * k_ratio)
        variance_percent = (k_ratio - 1.0) * 100

        return {
            'ready': True,
            'current_k_factor': self.current_k_factor,
            'period_start': self.period_start,
            'fuel_added': round(self.total_fuel_added, 1),
            'computed_used': round(self.total_computed_used, 1),
            'k_factor_ratio': round(k_ratio, 4),
            'variance_percent': round(variance_percent, 1),
            'suggested_k_factor': suggested_k,
            'recommendation': self._get_recommendation(variance_percent)
        }

    def _get_recommendation(self, variance_percent):
        """Generate human-readable recommendation."""
        if abs(variance_percent) < 1.0:
            return "K-factor is accurate (within 1%). No adjustment needed."
        elif variance_percent > 0:
            return f"Sensor reads {variance_percent:.1f}% HIGH. Increase K-factor."
        else:
            return f"Sensor reads {abs(variance_percent):.1f}% LOW. Decrease K-factor."

    def apply_k_factor(self, new_k_factor):
        """Record that user applied new K-factor to Dynon EMS."""
        self.calibration_history.append({
            'date': datetime.now().isoformat(),
            'old_k_factor': self.current_k_factor,
            'new_k_factor': new_k_factor,
            'fuel_added': self.total_fuel_added,
            'computed_used': self.total_computed_used,
            'k_ratio': self.total_computed_used / self.total_fuel_added if self.total_fuel_added > 0 else 1.0
        })
        self.current_k_factor = new_k_factor
        self.start_period()  # Reset for next period

    def to_dict(self):
        """Convert to dictionary for JSON serialization."""
        return {
            'current_k_factor': self.current_k_factor,
            'period_start': self.period_start,
            'total_fuel_added': self.total_fuel_added,
            'total_computed_used': self.total_computed_used,
            'history': self.calibration_history
        }

    def from_dict(self, data):
        """Load from dictionary."""
        self.current_k_factor = data.get('current_k_factor', FUEL_CONFIG['k_factor_default'])
        self.period_start = data.get('period_start')
        self.total_fuel_added = data.get('total_fuel_added', 0.0)
        self.total_computed_used = data.get('total_computed_used', 0.0)
        self.calibration_history = data.get('history', [])


class FuelTracker:
    """
    Manages fuel state, consumption tracking, and persistence.
    Integrates fuel flow over time to track fuel remaining.
    """

    def __init__(self, data_dir):
        self.lock = threading.RLock()  # RLock allows reentrant locking (same thread can acquire multiple times)
        self.data_dir = data_dir
        self.data_file = os.path.join(data_dir, FUEL_CONFIG['data_file'])

        # Core state
        self.fuel_remaining = 0.0
        self.flight_fuel_used = 0.0
        self.total_since_fill = 0.0
        self.last_edm_timestamp = None
        self.last_updated = None
        self.engine_running = False
        self.flight_start_time = None

        # Cruise efficiency tracking
        self.cruise_samples = []  # List of (timestamp, fuel_flow, ground_speed) tuples
        self.cruise_sample_limit = 600  # 10 minutes at 1Hz

        # Persistence
        self.last_save_time = 0

        # K-factor calibration
        self.calibration = KFactorCalibration()

        # History
        self.fuel_additions = []
        self.flight_history = []

        # Warnings
        self.fuel_warning_dismissed = False

        # EDM fuel tank readings (from EDM-700/800)
        self.edm_fuel_total = 0.0  # Total fuel remaining from EDM
        self.edm_fuel_left = 0.0   # Left tank from EDM
        self.edm_fuel_right = 0.0  # Right tank from EDM

        # Load existing state
        self._load_state()

    def update(self, fuel_flow, edm_timestamp, ground_speed, rpm, mp,
                fuel_total=0, fuel_left=0, fuel_right=0):
        """
        Process a new data sample. Called from capture_thread_func.

        Args:
            fuel_flow: Current fuel flow in GPH
            edm_timestamp: EDM timestamp in seconds since midnight
            ground_speed: Ground speed in knots (from Stratux)
            rpm: Engine RPM
            mp: Manifold pressure in inHg
            fuel_total: EDM total fuel remaining (gallons)
            fuel_left: EDM left tank fuel (gallons)
            fuel_right: EDM right tank fuel (gallons)
        """
        with self.lock:
            current_time = time.time()

            # Store EDM fuel tank readings
            self.edm_fuel_total = fuel_total
            self.edm_fuel_left = fuel_left
            self.edm_fuel_right = fuel_right

            # Detect engine start/stop
            was_running = self.engine_running
            self.engine_running = rpm > 500

            if self.engine_running and not was_running:
                self._on_engine_start(current_time)
            elif not self.engine_running and was_running:
                self._on_engine_stop()

            # Integrate fuel consumption
            if self.last_edm_timestamp is not None and self.engine_running:
                dt = edm_timestamp - self.last_edm_timestamp

                # Handle midnight wraparound
                if dt < 0:
                    dt += 86400  # 24 hours in seconds

                # Convert to hours for GPH calculation
                dt_hours = dt / 3600.0

                # Only integrate if time delta is reasonable (< 10 seconds)
                if dt_hours < (10.0 / 3600.0) and dt_hours > 0:
                    fuel_increment = fuel_flow * dt_hours
                    self.flight_fuel_used += fuel_increment
                    self.total_since_fill += fuel_increment
                    self.fuel_remaining = max(0, self.fuel_remaining - fuel_increment)

            self.last_edm_timestamp = edm_timestamp
            self.last_updated = datetime.now().isoformat()

            # Track cruise samples for efficiency calculation
            if self._is_cruise(rpm, mp, ground_speed):
                self.cruise_samples.append((current_time, fuel_flow, ground_speed))
                if len(self.cruise_samples) > self.cruise_sample_limit:
                    self.cruise_samples.pop(0)

            # Periodic save
            self._maybe_save(current_time)

    def _is_cruise(self, rpm, mp, ground_speed):
        """Determine if currently in stable cruise flight."""
        return (
            FUEL_CONFIG['cruise_rpm_min'] < rpm < FUEL_CONFIG['cruise_rpm_max'] and
            FUEL_CONFIG['cruise_mp_min'] < mp < FUEL_CONFIG['cruise_mp_max'] and
            ground_speed > FUEL_CONFIG['cruise_gs_min']
        )

    def get_cruise_efficiency(self):
        """Calculate nm/gal, range, endurance from cruise samples."""
        with self.lock:
            if len(self.cruise_samples) < 60:  # Need ~1 minute of data
                return None

            # Use last 5 minutes of cruise data
            recent = self.cruise_samples[-300:]

            avg_ff = sum(s[1] for s in recent) / len(recent)
            avg_gs = sum(s[2] for s in recent) / len(recent)

            if avg_ff <= 0:
                return None

            nmpg = avg_gs / avg_ff

            return {
                'avg_fuel_flow': round(avg_ff, 1),
                'avg_ground_speed': round(avg_gs, 0),
                'nm_per_gallon': round(nmpg, 1),
                'range_remaining': round(self.fuel_remaining * nmpg, 0),
                'endurance_hours': round(self.fuel_remaining / avg_ff, 2)
            }

    def check_warnings(self):
        """Check for low fuel and low endurance warnings."""
        warnings = []

        with self.lock:
            if self.fuel_warning_dismissed:
                return warnings

            if self.fuel_remaining <= FUEL_CONFIG['low_fuel_critical_gal']:
                warnings.append({
                    'level': 'critical',
                    'message': f'CRITICAL: {self.fuel_remaining:.1f} gal remaining'
                })
            elif self.fuel_remaining <= FUEL_CONFIG['low_fuel_warning_gal']:
                warnings.append({
                    'level': 'warning',
                    'message': f'LOW FUEL: {self.fuel_remaining:.1f} gal remaining'
                })

            # Check endurance
            efficiency = self.get_cruise_efficiency()
            if efficiency:
                endurance_min = efficiency['endurance_hours'] * 60
                if endurance_min < FUEL_CONFIG['min_endurance_minutes']:
                    warnings.append({
                        'level': 'warning',
                        'message': f'LOW ENDURANCE: {int(endurance_min)} min at current consumption'
                    })

        return warnings

    def _on_engine_start(self, timestamp):
        """Reset flight counters on engine start."""
        self.flight_fuel_used = 0.0
        self.cruise_samples = []
        self.flight_start_time = timestamp
        self.fuel_warning_dismissed = False
        log("FuelTracker: Engine start detected - flight counters reset")

    def _on_engine_stop(self):
        """Log flight record on engine stop."""
        if self.flight_start_time is None:
            return

        duration_minutes = (time.time() - self.flight_start_time) / 60

        # Only log if flight was > 5 minutes
        if duration_minutes > 5 and self.flight_fuel_used > 0.5:
            efficiency = self.get_cruise_efficiency()
            flight_record = {
                'id': str(uuid.uuid4()),
                'date': datetime.now().isoformat(),
                'duration_minutes': round(duration_minutes, 1),
                'fuel_used': round(self.flight_fuel_used, 1),
                'fuel_remaining_start': round(self.fuel_remaining + self.flight_fuel_used, 1),
                'fuel_remaining_end': round(self.fuel_remaining, 1),
            }
            if efficiency:
                flight_record['avg_cruise_ff'] = efficiency['avg_fuel_flow']
                flight_record['avg_cruise_gs'] = efficiency['avg_ground_speed']
                flight_record['efficiency_nmpg'] = efficiency['nm_per_gallon']

            self.flight_history.append(flight_record)
            # Keep last 50 flights
            if len(self.flight_history) > 50:
                self.flight_history = self.flight_history[-50:]

            # Record computed usage for K-factor calibration
            self.calibration.record_computed_usage(self.flight_fuel_used)

            log(f"FuelTracker: Flight logged - {duration_minutes:.1f} min, {self.flight_fuel_used:.1f} gal used")
            self._save_state()

        self.flight_start_time = None

    def add_fuel(self, gallons, airport='', price_per_gallon=None, notes='',
                 set_total=False, include_in_calibration=True):
        """
        Record fuel addition.

        Args:
            gallons: Gallons added (or total if set_total=True)
            airport: Airport identifier
            price_per_gallon: Price per gallon (optional)
            notes: Notes about the fuel addition
            set_total: If True, set fuel_remaining to gallons; if False, add gallons
            include_in_calibration: Include in K-factor calibration
        """
        with self.lock:
            fuel_before = self.fuel_remaining

            if set_total:
                self.fuel_remaining = gallons
                gallons_added = gallons - fuel_before
            else:
                self.fuel_remaining += gallons
                gallons_added = gallons

            # Cap at aircraft capacity (36 gal; "usable capacity" is deprecated)
            self.fuel_remaining = min(self.fuel_remaining, FUEL_CONFIG['capacity_gal'])

            # Reset total since fill if this was a fill-up
            if set_total or self.fuel_remaining >= FUEL_CONFIG['capacity_gal'] * 0.95:
                self.total_since_fill = 0.0

            addition = {
                'id': str(uuid.uuid4()),
                'date': datetime.now().strftime('%Y-%m-%d'),
                'time': datetime.now().strftime('%H:%M'),
                'airport': airport.upper() if airport else '',
                'gallons': round(gallons_added, 1),
                'price_per_gallon': price_per_gallon,
                'total_cost': round(gallons_added * price_per_gallon, 2) if price_per_gallon else None,
                'fuel_remaining_before': round(fuel_before, 1),
                'fuel_remaining_after': round(self.fuel_remaining, 1),
                'set_total': set_total,
                'include_in_calibration': include_in_calibration,
                'notes': notes
            }
            self.fuel_additions.append(addition)

            # Record for K-factor calibration
            if include_in_calibration and gallons_added > 0:
                self.calibration.record_fuel_addition(gallons_added)

            self.last_updated = datetime.now().isoformat()
            log(f"FuelTracker: Added {gallons_added:.1f} gal at {airport}, now {self.fuel_remaining:.1f} gal")
            self._save_state()

            return addition

    def set_fuel(self, gallons, reason=''):
        """Manual override of fuel remaining."""
        with self.lock:
            old_value = self.fuel_remaining
            self.fuel_remaining = max(0, min(gallons, FUEL_CONFIG['capacity_gal']))
            self.last_updated = datetime.now().isoformat()
            log(f"FuelTracker: Manual set from {old_value:.1f} to {self.fuel_remaining:.1f} gal - {reason}")
            self._save_state()

    def dismiss_warning(self):
        """Dismiss fuel warning for this flight."""
        with self.lock:
            self.fuel_warning_dismissed = True

    def get_status(self):
        """Get current fuel status for API response."""
        with self.lock:
            efficiency = self.get_cruise_efficiency()
            warnings = self.check_warnings()

            result = {
                'fuel_remaining': round(self.fuel_remaining, 1),
                'flight_fuel_used': round(self.flight_fuel_used, 1),
                'total_since_fill': round(self.total_since_fill, 1),
                'engine_running': self.engine_running,
                'last_updated': self.last_updated,
                # Key name kept for the client JSON contract; value is now the full
                # 36 gal aircraft capacity ("usable capacity" is deprecated).
                'capacity': FUEL_CONFIG['capacity_gal'],
                'warnings': warnings,
                # EDM fuel tank readings
                'edm_fuel_total': round(self.edm_fuel_total, 1),
                'edm_fuel_left': round(self.edm_fuel_left, 1),
                'edm_fuel_right': round(self.edm_fuel_right, 1),
            }

            if efficiency:
                result['cruise_efficiency'] = efficiency
                result['endurance_hours'] = efficiency['endurance_hours']
                result['range_nm'] = efficiency['range_remaining']
            else:
                # Estimate endurance from average fuel flow
                avg_ff = 8.0  # Default cruise fuel flow
                result['endurance_hours'] = round(self.fuel_remaining / avg_ff, 2) if avg_ff > 0 else 0
                result['range_nm'] = round(self.fuel_remaining * 17, 0)  # Rough estimate

            return result

    def _maybe_save(self, current_time):
        """Save if save_interval has elapsed."""
        if current_time - self.last_save_time >= FUEL_CONFIG['save_interval']:
            self._save_state()
            self.last_save_time = current_time

    def _save_state(self):
        """Save state to fuel_data.json with backup rotation."""
        try:
            # Rotate backups
            for i in range(4, 0, -1):
                old_backup = f"{self.data_file}.{i}"
                new_backup = f"{self.data_file}.{i+1}"
                if os.path.exists(old_backup):
                    shutil.move(old_backup, new_backup)

            if os.path.exists(self.data_file):
                shutil.copy2(self.data_file, f"{self.data_file}.1")

            # Save current state
            data = {
                'version': 1,
                'aircraft': {
                    'fuel_capacity': FUEL_CONFIG['capacity_gal'],
                    # DEPRECATED field, kept so existing fuel_data.json files keep the
                    # same shape. Now identical to fuel_capacity.
                    'usable_capacity': FUEL_CONFIG['capacity_gal']
                },
                'current_state': {
                    'fuel_remaining': self.fuel_remaining,
                    'last_updated': self.last_updated,
                    'flight_fuel_used': self.flight_fuel_used,
                    'total_since_fill': self.total_since_fill,
                    'engine_running': self.engine_running
                },
                'fuel_additions': self.fuel_additions[-100:],  # Keep last 100
                'flight_history': self.flight_history[-50:],   # Keep last 50
                'calibration': self.calibration.to_dict()
            }

            with open(self.data_file, 'w') as f:
                json.dump(data, f, indent=2)

        except Exception as e:
            log(f"FuelTracker: Error saving state: {e}")

    def _load_state(self):
        """Load state from fuel_data.json."""
        if not os.path.exists(self.data_file):
            log("FuelTracker: No existing state file, starting fresh")
            self.calibration.start_period()
            return

        try:
            with open(self.data_file, 'r') as f:
                data = json.load(f)

            state = data.get('current_state', {})
            self.fuel_remaining = state.get('fuel_remaining', 0.0)
            self.last_updated = state.get('last_updated')
            self.total_since_fill = state.get('total_since_fill', 0.0)
            # Don't restore flight_fuel_used - start fresh each session
            self.flight_fuel_used = 0.0
            self.engine_running = False

            self.fuel_additions = data.get('fuel_additions', [])
            self.flight_history = data.get('flight_history', [])

            if 'calibration' in data:
                self.calibration.from_dict(data['calibration'])
            else:
                self.calibration.start_period()

            log(f"FuelTracker: Loaded state - {self.fuel_remaining:.1f} gal remaining")

        except Exception as e:
            log(f"FuelTracker: Error loading state: {e}")
            self.calibration.start_period()


# Global state
class CaptureState:
    def __init__(self):
        self.lock = threading.Lock()
        self.capturing = False
        self.capture_thread = None
        self.stop_event = threading.Event()
        self.latest_data = {}
        self.data_count = 0
        self.capture_start_time = None
        self.last_error = None
        self.serial_connected = False
        # History for plotting (30 minutes)
        self.history = deque(maxlen=MAX_HISTORY_POINTS)
        # Fuel flow smoothing buffer: list of (timestamp, value) tuples for time-based smoothing
        self.ff_buffer = []
        # Calculated values
        self.rop_lop_percent = 0  # Deviation percentage
        self.rop_lop_mode = "---"  # "RICH", "LEAN", "PEAK", or "---"
        self.sfc = 0  # Specific Fuel Consumption
        self.percent_power = 0  # Percent of rated power
        # Stratux data
        self.stratux_connected = False
        self.stratux_thread = None
        self.gps_altitude = 0  # GPS altitude MSL in feet
        self.pressure_altitude = 0  # Barometric pressure altitude in feet
        self.ground_speed = 0  # Ground speed in knots
        # GPS position and attitude from Stratux (for CSV export)
        self.latitude = None
        self.longitude = None
        self.course = None
        self.pitch = None
        self.bank = None
        self.acc_vert = None
        self.oat = 0  # Outside air temperature in °C (calculated from standard atmosphere)
        # Calculated flight data
        self.density_altitude = 0  # Density altitude in feet
        self.tas = 0  # True airspeed in knots
        self.target_fuel_flow = 0  # Optimal fuel flow for cruise
        self.target_power = 0  # Recommended power setting
        self.target_mode = "---"  # Recommended mixture mode
        # Sticky valve detection (TIME-BASED)
        self.engine_start_time = None  # When engine first started (RPM > 500)
        self.sticky_valve_alert = None  # Cylinder number if sticky valve detected (1-4)
        self.sticky_valve_start_times = [None, None, None, None]  # When each cylinder first showed low EGT
        self.sticky_valve_dismissed = False  # User dismissed the alert
        # Fuel tracking (initialized in main() after CONFIG is finalized)
        self.fuel_tracker = None
        # Serial connection health monitoring
        self.last_data_time = None  # Timestamp of last successful data read
        self.empty_read_count = 0  # Consecutive empty reads (ready but no data)
        self.serial_warning = None  # Warning message for UI (None = no warning)
        self.reconnect_count = 0  # Number of auto-reconnect attempts
        # Lightweight diagnostics (counts only, no lists)
        self.serial_open_time = None  # When port was opened
        self.last_serial_error = None  # Last error message
        self.bytes_received = 0  # Total bytes received
        self.lines_received = 0  # Total lines received
        self.parse_errors = 0  # Lines that failed to parse
        self.buffer_overflows = 0  # Count of buffer overflow events
        # Per-cylinder peak EGT tracking
        self.peak_egts = [0, 0, 0, 0]  # Peak EGT for each cylinder (1-4)
        self.degrees_from_peak = [0, 0, 0, 0]  # Current EGT minus peak (negative = LOP)
        self.leaning_active = False  # Currently in a leaning event
        self.ff_history = []  # Recent fuel flow samples: [(timestamp, ff), ...]
        self.last_stable_rpm = 0  # RPM when peaks were captured
        self.last_stable_mp = 0  # MP when peaks were captured
        self.peaks_valid = False  # True if we have valid peak data to display
        # Manual ATIS data (overrides calculated values when set)
        self.manual_altimeter = None  # Altimeter setting in inHg (e.g., 29.92)
        self.manual_oat = None  # OAT in °C from ATIS
        # Server reference for shutdown
        self.server = None
        self.shutdown_requested = False
        # Server-side CSV recording
        self.csv_points = 0

state = CaptureState()


class FilePlaybackReader:
    """Mock serial port that reads from captured file for desktop playback testing.

    Emulates pyserial's Serial interface for reading EDM data from captured files.
    Maintains realistic timing based on EDM timestamps in the data.
    """

    def __init__(self, filepath, rate=1.0):
        """Initialize playback reader.

        Args:
            filepath: Path to captured stream file (e.g., stream_2025-01-10_14-30-00.txt)
            rate: Playback speed multiplier (1.0 = realtime, 10.0 = 10x speed)
        """
        self.filepath = filepath
        self.rate = rate
        self.file = open(filepath, 'r')
        self.last_wall_time = None  # Wall clock time of last read
        self.last_edm_time = None   # EDM timestamp of last valid line
        self.eof_reached = False
        log(f"FilePlaybackReader: Opened {filepath} at {rate}x speed")

    def _parse_edm_timestamp(self, line):
        """Extract EDM timestamp from line (seconds since midnight with fractional precision).

        EDM format: first 8 chars are HHMMSSFF where FF is 1/64 second fraction.
        """
        line = line.strip()
        if len(line) < 8:
            return None
        try:
            hours = int(line[0:2])
            minutes = int(line[2:4])
            seconds = int(line[4:6])
            fraction = int(line[6:8])  # 1/64 of a second
            if 0 <= hours <= 23 and 0 <= minutes <= 59 and 0 <= seconds <= 59:
                return hours * 3600 + minutes * 60 + seconds + (fraction / 64.0)
        except (ValueError, IndexError):
            pass
        return None

    def readline(self):
        """Read next line, maintaining realistic playback timing.

        Returns:
            bytes: Next line encoded as UTF-8, or empty bytes at EOF
        """
        if self.eof_reached:
            return b''

        while True:
            line = self.file.readline()
            if not line:
                self.eof_reached = True
                log("FilePlaybackReader: End of file reached")
                return b''

            # Skip blank lines
            if not line.strip():
                continue

            # Try to parse timestamp for timing sync
            edm_time = self._parse_edm_timestamp(line)

            if edm_time is not None:
                current_wall_time = time.time()

                if self.last_edm_time is not None and self.last_wall_time is not None:
                    # Calculate how long to wait based on EDM time difference
                    edm_delta = edm_time - self.last_edm_time

                    # Handle midnight rollover
                    if edm_delta < 0:
                        edm_delta += 86400  # Add 24 hours

                    # Skip sleep if delta is unreasonably large (corrupted data or gap)
                    # Just continue without sleeping - this resets timing after corruption
                    if edm_delta > 60:
                        pass  # Skip sleep, just update timestamps below
                    else:
                        # Apply playback rate and calculate required sleep
                        target_wall_delta = edm_delta / self.rate
                        actual_wall_delta = current_wall_time - self.last_wall_time
                        sleep_time = target_wall_delta - actual_wall_delta

                        if sleep_time > 0:
                            time.sleep(sleep_time)

                self.last_edm_time = edm_time
                self.last_wall_time = time.time()

            return line.encode('utf-8')

    def close(self):
        """Close the file."""
        if self.file:
            self.file.close()
            self.file = None
            log("FilePlaybackReader: Closed file")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


class KMLGPSProvider:
    """Provides GPS data from KML file, synchronized to playback time.

    Parses ForeFlight/CloudAhoy KML track logs and provides GPS data
    (altitude, ground speed, position) matched to EDM timestamps.
    """

    def __init__(self, kml_path):
        """Initialize KML GPS provider.

        Args:
            kml_path: Path to KML track log file
        """
        self.kml_path = kml_path
        self.data = []  # List of dicts with time_seconds, lat, lon, altitude_ft, speed_kts
        self._parse_kml(kml_path)
        self._current_index = 0
        log(f"KMLGPSProvider: Loaded {len(self.data)} GPS points from {kml_path}")

    def _parse_kml(self, kml_path):
        """Parse KML file and extract track data.

        Extracts time, coordinates, and extended data (speed, bank, pitch, etc.)
        from KML gx:Track format used by ForeFlight.
        """
        try:
            tree = ET.parse(kml_path)
            root = tree.getroot()

            # KML namespaces
            namespaces = {
                'kml': 'http://www.opengis.net/kml/2.2',
                'gx': 'http://www.google.com/kml/ext/2.2'
            }

            # Find all tracks
            for track in root.findall('.//gx:Track', namespaces):
                whens = track.findall('.//kml:when', namespaces)
                coords = track.findall('.//gx:coord', namespaces)

                # Find extended data arrays
                speeds = root.findall('.//gx:SimpleArrayData[@name="speed_kts"]/gx:value', namespaces)
                banks = root.findall('.//gx:SimpleArrayData[@name="bank"]/gx:value', namespaces)
                pitches = root.findall('.//gx:SimpleArrayData[@name="pitch"]/gx:value', namespaces)
                courses = root.findall('.//gx:SimpleArrayData[@name="course"]/gx:value', namespaces)

                # Meters to feet conversion
                meters_to_feet = 3.28084

                # Process each point
                for i, (when, coord) in enumerate(zip(whens, coords)):
                    if when.text is None or coord.text is None:
                        continue

                    try:
                        # Parse time: 2024-06-07T14:11:43Z
                        time_str = when.text.split('T')[1][:8]  # HH:MM:SS
                        h, m, s = map(int, time_str.split(':'))
                        time_seconds = h * 3600 + m * 60 + s

                        # Parse coordinates: lon lat alt
                        coord_parts = coord.text.strip().split()
                        lon = float(coord_parts[0])
                        lat = float(coord_parts[1])
                        alt_m = float(coord_parts[2]) if len(coord_parts) > 2 else 0
                        alt_ft = int(alt_m * meters_to_feet)

                        # Get speed if available
                        speed_kts = 0
                        if i < len(speeds) and speeds[i].text:
                            speed_kts = float(speeds[i].text)

                        # Get course if available
                        course = 0
                        if i < len(courses) and courses[i].text:
                            course = float(courses[i].text)

                        # Get bank and pitch if available
                        bank = 0
                        pitch = 0
                        if i < len(banks) and banks[i].text:
                            bank = float(banks[i].text)
                        if i < len(pitches) and pitches[i].text:
                            pitch = float(pitches[i].text)

                        self.data.append({
                            'time_seconds': time_seconds,
                            'time_str': time_str,
                            'lat': lat,
                            'lon': lon,
                            'altitude_ft': alt_ft,
                            'speed_kts': speed_kts,
                            'course': course,
                            'bank': bank,
                            'pitch': pitch,
                        })
                    except (ValueError, IndexError) as e:
                        continue

            # Sort by time
            self.data.sort(key=lambda x: x['time_seconds'])

        except Exception as e:
            log(f"KMLGPSProvider: Error parsing KML file: {e}")

    def get_data_at_time(self, time_seconds):
        """Get GPS data for a given time (seconds since midnight).

        Uses nearest-neighbor matching to find the closest GPS point.

        Args:
            time_seconds: EDM timestamp (seconds since midnight)

        Returns:
            dict with altitude_ft, speed_kts, lat, lon, etc. or None if no data
        """
        if not self.data or time_seconds is None:
            return None

        # Handle midnight rollover - if time is much smaller than our data,
        # assume next day
        if time_seconds < self.data[0]['time_seconds'] - 43200:  # More than 12 hours before start
            time_seconds += 86400

        # Binary search for nearest point (optimization for large KML files)
        best_idx = 0
        best_diff = abs(self.data[0]['time_seconds'] - time_seconds)

        for i, point in enumerate(self.data):
            diff = abs(point['time_seconds'] - time_seconds)
            if diff < best_diff:
                best_diff = diff
                best_idx = i

        # Return nearest point if within 30 seconds
        if best_diff <= 30:
            return self.data[best_idx]

        return None

    def get_data_at_time_str(self, time_str):
        """Get GPS data for a given time string (HH:MM:SS format).

        Args:
            time_str: Time in HH:MM:SS format

        Returns:
            dict with altitude_ft, speed_kts, lat, lon, etc. or None if no data
        """
        if not time_str:
            return None
        try:
            parts = time_str.split(':')
            h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
            time_seconds = h * 3600 + m * 60 + s
            return self.get_data_at_time(time_seconds)
        except (ValueError, IndexError):
            return None


def log(message):
    """Log to file and stdout."""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_line = f"{timestamp} {message}"
    print(log_line)
    try:
        log_path = os.path.join(CONFIG['DATA_DIR'], CONFIG['LOG_FILE'])
        with open(log_path, 'a') as f:
            f.write(log_line + '\n')
    except:
        pass

# Shared-secret token gating /api/upload (Finding 8: unauthenticated upload
# endpoint). Self-provisions on first boot — no manual deploy step required —
# and persists in DATA_DIR alongside fuel_data.json so it survives redeploys
# of this script.
UPLOAD_TOKEN_FILE = os.path.join(CONFIG['DATA_DIR'], '.upload_token')
MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5 MB — largest real upload target today
                                     # (engine_monitor.py) is ~193 KB; ~26x headroom.

def _load_or_create_upload_token():
    try:
        if os.path.exists(UPLOAD_TOKEN_FILE):
            with open(UPLOAD_TOKEN_FILE, 'r') as f:
                tok = f.read().strip()
                if tok:
                    return tok
        os.makedirs(os.path.dirname(UPLOAD_TOKEN_FILE), exist_ok=True)
        tok = secrets.token_hex(32)
        with open(UPLOAD_TOKEN_FILE, 'w') as f:
            f.write(tok)
        os.chmod(UPLOAD_TOKEN_FILE, 0o600)
        log(f"Generated new /api/upload token at {UPLOAD_TOKEN_FILE}")
        return tok
    except Exception as e:
        log(f"WARNING: could not load/create upload token ({e}) — /api/upload will reject all requests")
        return None

UPLOAD_TOKEN = _load_or_create_upload_token()

def extract_numeric(s):
    """Extract numeric value from a field that may have text prefix (e.g., 'CRB00117' -> 117)."""
    if not s:
        return 0
    # Remove any non-numeric prefix, keeping minus sign and digits
    import re
    match = re.search(r'-?\d+', s)
    if match:
        return int(match.group())
    return 0

def parse_line(line):
    """Parse a single line of EDM data."""
    line = line.strip()
    if not line or len(line) < sum(FIELD_WIDTHS) or '\x00' in line:
        return None

    try:
        # Extract fields by width
        fields = []
        pos = 0
        for width in FIELD_WIDTHS:
            fields.append(line[pos:pos+width].strip())
            pos += width

        # Validate time
        hours, minutes, seconds = int(fields[0]), int(fields[1]), int(fields[2])
        if not (0 <= hours <= 23 and 0 <= minutes <= 59 and 0 <= seconds <= 59):
            return None

        # Parse fractional seconds (field 3 is 1/64 of a second)
        fraction = int(fields[3]) if fields[3] else 0
        frac_seconds = fraction / 64.0

        # Calculate EDM timestamp as seconds since midnight (with fractional precision)
        edm_timestamp = hours * 3600 + minutes * 60 + seconds + frac_seconds

        # Parse numeric values (using extract_numeric for fields that may have text prefixes)
        data = {
            'time': f"{hours:02d}:{minutes:02d}:{seconds:02d}",
            'edm_timestamp': edm_timestamp,  # Seconds since midnight with 1/64 sec precision
            'MP': float(fields[4]) / 100 if fields[4] else 0,
            'Oil_Temp': extract_numeric(fields[5]),
            'Oil_Press': extract_numeric(fields[6]),
            'Volts': float(fields[8]) / 10 if fields[8] else 0,
            'RPM': extract_numeric(fields[10]) * 10,
            'Fuel_Flow': float(fields[11]) / 10 if fields[11] else 0,
            # EDM fuel tank data (in tenths of gallon)
            'Fuel_Remaining': float(fields[12]) / 10 if fields[12] else 0,
            'Fuel_Left': float(fields[13]) / 10 if fields[13] else 0,
            'Fuel_Right': float(fields[14]) / 10 if fields[14] else 0,
            'Carb_Temp': extract_numeric(fields[15]),
            'EGT1': extract_numeric(fields[19]),
            'EGT2': extract_numeric(fields[20]),
            'EGT3': extract_numeric(fields[21]),
            'EGT4': extract_numeric(fields[22]),
            'CHT1': extract_numeric(fields[25]),
            'CHT2': extract_numeric(fields[26]),
            'CHT3': extract_numeric(fields[27]),
            'CHT4': extract_numeric(fields[28]),
            # Additional fields for CSV export
            'Fuel_Press': float(fields[7]) / 10 if fields[7] else 0,
            'Amps': extract_numeric(fields[9]),
            'GP2': fields[16].strip() if len(fields) > 16 else '',
            'GP3': fields[17].strip() if len(fields) > 17 else '',
            'Thermo': extract_numeric(fields[18]) if len(fields) > 18 else 0,
        }
        return data
    except (ValueError, IndexError) as e:
        return None

def get_smoothed_fuel_flow(fuel_flow, edm_timestamp):
    """
    Apply smoothing to fuel flow to compensate for carbureted float bowl lag.
    The float bowl fills and empties causing oscillations in measured fuel flow.
    Uses a rolling average over FF_SMOOTHING_SECONDS (time-based, not sample-based).

    Args:
        fuel_flow: Current fuel flow reading
        edm_timestamp: EDM timestamp in seconds since midnight (with 1/64 sec precision)
    """
    # Add current reading with timestamp
    state.ff_buffer.append((edm_timestamp, fuel_flow))

    # Remove readings older than FF_SMOOTHING_SECONDS
    # Handle midnight wraparound (86400 seconds in a day)
    cutoff = edm_timestamp - FF_SMOOTHING_SECONDS
    if cutoff < 0:
        # Handle wraparound - keep values from before midnight or after cutoff
        state.ff_buffer = [(t, v) for t, v in state.ff_buffer
                          if t >= cutoff + 86400 or t <= edm_timestamp]
    else:
        state.ff_buffer = [(t, v) for t, v in state.ff_buffer if t >= cutoff]

    if len(state.ff_buffer) == 0:
        return fuel_flow

    # Return average of values in the time window
    return sum(v for t, v in state.ff_buffer) / len(state.ff_buffer)

def calculate_percent_power_from_rpm_mp(rpm, mp):
    """
    Calculate percent power from RPM and Manifold Pressure.
    Based on Lycoming O-360-A1A performance data.

    Formula approximation for normally aspirated engine:
    Power is roughly proportional to (RPM * MP) / (rated RPM * rated MP)

    Note: This is simplified - actual power varies with altitude and temperature.
    """
    if rpm < 1000 or mp < 15:
        return 0

    # Basic percent power from RPM and MP
    # Normalized to rated conditions (2700 RPM, 29" MP = 100%)
    percent = (rpm / ENGINE_RATED_RPM) * (mp / ENGINE_RATED_MP) * 100
    return min(percent, 100)

def calculate_percent_power_from_fuel_flow(fuel_flow, is_lop=False):
    """
    Calculate percent power from fuel flow.

    For LOP operation (8.5:1 compression O-360):
    HP = Fuel Flow (GPH) * 14.9

    For ROP operation:
    HP = Fuel Flow (GPH) / 0.50 (best power SFC)

    Sources: Lycoming performance data, GAMI lean testing
    """
    if fuel_flow < 1:
        return 0

    if is_lop:
        # LOP: HP directly proportional to fuel flow
        # HP = FF * 14.9 for 8.5:1 compression
        hp = fuel_flow * COMPRESSION_RATIO_FACTOR
    else:
        # ROP: Use best power SFC (approximately 0.50 GPH/HP)
        hp = fuel_flow / BEST_POWER_SFC

    percent = (hp / ENGINE_MAX_HP) * 100
    return min(percent, 100)

def calculate_engine_parameters(rpm, mp, fuel_flow, edm_timestamp):
    """
    Calculate all engine parameters.

    For carbureted O-360-A1A:
    - RICH mode: Power calculated from RPM/MP (throttle position)
    - LEAN mode: Power calculated from fuel flow (fuel limited)
    - Float bowl oscillations cause fuel flow fluctuations
    - Using smoothed fuel flow helps compensate for lag

    Args:
        rpm: Engine RPM
        mp: Manifold pressure in inHg
        fuel_flow: Fuel flow in GPH
        edm_timestamp: EDM timestamp in seconds since midnight (for time-based smoothing)

    Returns: (percent_power, rop_lop_percent, rop_lop_mode, sfc)
    """
    # Get smoothed fuel flow to compensate for float bowl lag (time-based)
    smoothed_ff = get_smoothed_fuel_flow(fuel_flow, edm_timestamp)

    # Calculate percent power from RPM/MP
    pwr_from_rpm_mp = calculate_percent_power_from_rpm_mp(rpm, mp)

    # Calculate expected fuel flow at this power setting for best power (ROP)
    hp_from_rpm_mp = (pwr_from_rpm_mp / 100) * ENGINE_MAX_HP
    expected_ff_rop = hp_from_rpm_mp * BEST_POWER_SFC  # GPH at best power
    expected_ff_lop = hp_from_rpm_mp * BEST_ECONOMY_SFC  # GPH at best economy

    # Determine if running RICH or LEAN based on fuel flow vs expected
    # If FF is higher than expected ROP, definitely RICH
    # If FF is lower than expected LOP, definitely LEAN
    # In between could be near peak

    if smoothed_ff >= expected_ff_rop * 0.95:
        # RICH of Peak - fuel flow at or above best power
        mode = "RICH"
        # RICH mode: use RPM/MP for power (throttle determines power)
        percent_power = pwr_from_rpm_mp
        # Deviation: how much richer than best power
        deviation = ((smoothed_ff - expected_ff_rop) / expected_ff_rop) * 100 if expected_ff_rop > 0 else 0

    elif smoothed_ff <= expected_ff_lop * 1.05:
        # LEAN of Peak - fuel flow at or below best economy
        mode = "LEAN"
        # LEAN mode: use fuel flow for power (fuel limited)
        percent_power = calculate_percent_power_from_fuel_flow(smoothed_ff, is_lop=True)
        # Deviation: how much leaner than best economy
        deviation = ((expected_ff_lop - smoothed_ff) / expected_ff_lop) * 100 if expected_ff_lop > 0 else 0

    else:
        # Near peak EGT - between best power and best economy
        mode = "PEAK"
        # At peak, use RPM/MP for power
        percent_power = pwr_from_rpm_mp
        deviation = 0

    # Calculate BSFC (Brake Specific Fuel Consumption) in lbs/HP/hr
    # This is the standard aviation unit. Convert from GPH by multiplying by avgas density (6 lbs/gal)
    if percent_power > 0 and smoothed_ff > 0:
        hp = (percent_power / 100) * ENGINE_MAX_HP
        sfc_gph_per_hp = smoothed_ff / hp if hp > 0 else 0
        bsfc = sfc_gph_per_hp * 6.0  # Convert to lbs/HP/hr
    else:
        bsfc = 0

    return round(percent_power, 1), round(deviation, 1), mode, round(bsfc, 2)

def check_sticky_valve(egt1, egt2, egt3, egt4, rpm):
    """
    Check for sticky exhaust valve condition during engine warmup.

    A sticky valve causes one cylinder to not fire, resulting in:
    - Very low or zero EGT on that cylinder
    - Other cylinders showing normal EGT

    This is most common during cold starts ("morning sickness").

    Uses TIME-BASED detection: tracks when each cylinder first showed low EGT,
    and triggers alert if condition persists for STICKY_VALVE_PERSIST_SECONDS.
    This works correctly regardless of data sample rate.

    Returns: cylinder number (1-4) if sticky valve detected, None otherwise
    """
    egts = [egt1, egt2, egt3, egt4]
    current_time = time.time()

    # Only check during warmup period
    if state.engine_start_time is None:
        # Detect engine start (RPM > 500)
        if rpm > 500:
            state.engine_start_time = current_time
            state.sticky_valve_start_times = [None, None, None, None]
            state.sticky_valve_alert = None
            state.sticky_valve_dismissed = False
            log("Engine start detected - monitoring for sticky valve")
        return None

    # Check if still in warmup period
    elapsed_minutes = (current_time - state.engine_start_time) / 60
    if elapsed_minutes > STICKY_VALVE_WARMUP_MINUTES:
        return state.sticky_valve_alert  # Keep existing alert if any

    # Reset engine start time if engine stopped
    if rpm < 300:
        state.engine_start_time = None
        state.sticky_valve_start_times = [None, None, None, None]
        return None

    # Calculate average EGT of all cylinders
    avg_all = sum(egts) / 4

    # Need minimum EGT to detect (engine must be producing heat)
    if avg_all < STICKY_VALVE_MIN_EGT:
        return state.sticky_valve_alert

    # Check each cylinder against average of the OTHER three
    for i in range(4):
        other_egts = [egts[j] for j in range(4) if j != i]
        avg_others = sum(other_egts) / 3

        # Skip if others aren't hot enough to compare
        if avg_others < STICKY_VALVE_MIN_EGT:
            continue

        # Check if this cylinder is significantly colder
        ratio = egts[i] / avg_others if avg_others > 0 else 1.0

        if ratio < STICKY_VALVE_EGT_RATIO:
            # This cylinder is too cold - record when it started (if not already)
            if state.sticky_valve_start_times[i] is None:
                state.sticky_valve_start_times[i] = current_time

            # Check if condition has persisted long enough (TIME-BASED)
            elapsed_cold = current_time - state.sticky_valve_start_times[i]
            if elapsed_cold >= STICKY_VALVE_PERSIST_SECONDS:
                if state.sticky_valve_alert != (i + 1):
                    state.sticky_valve_alert = i + 1  # 1-indexed cylinder number
                    log(f"STICKY VALVE ALERT: Cylinder {i + 1} EGT ({egts[i]}°F) is {ratio*100:.0f}% of others ({avg_others:.0f}°F avg) for {elapsed_cold:.0f}s")
        else:
            # Cylinder is OK - reset its start time
            state.sticky_valve_start_times[i] = None
            # Clear alert if this was the alerting cylinder and it recovered
            if state.sticky_valve_alert == (i + 1):
                log(f"Sticky valve alert cleared: Cylinder {i + 1} EGT recovered")
                state.sticky_valve_alert = None

    return state.sticky_valve_alert


def update_peak_tracking(egt1, egt2, egt3, egt4, fuel_flow, rpm, mp):
    """
    Track peak EGT for each cylinder during leaning events.

    Detects leaning when fuel flow decreases steadily.
    Tracks peaks until power setting changes or mixture is enriched.
    Updates state.degrees_from_peak for UI display.

    Args:
        egt1-4: EGT values for each cylinder in °F
        fuel_flow: Current fuel flow in GPH
        rpm: Engine RPM
        mp: Manifold pressure in inHg
    """
    current_time = time.time()
    egts = [egt1, egt2, egt3, egt4]

    # Maintain fuel flow history (last 15 seconds)
    state.ff_history.append((current_time, fuel_flow))
    state.ff_history = [(t, ff) for t, ff in state.ff_history if current_time - t <= 15]

    # Check if engine is running with valid EGTs
    avg_egt = sum(egts) / 4
    if rpm < 500 or avg_egt < 800:
        # Engine not running or warming up - reset everything
        state.leaning_active = False
        state.peaks_valid = False
        state.peak_egts = [0, 0, 0, 0]
        state.degrees_from_peak = [0, 0, 0, 0]
        state.ff_history = []
        return

    # Check for power setting change (reset peaks if significant change)
    if state.peaks_valid:
        rpm_change = abs(rpm - state.last_stable_rpm) / max(state.last_stable_rpm, 1) * 100
        mp_change = abs(mp - state.last_stable_mp) / max(state.last_stable_mp, 1) * 100
        if rpm_change > 5 or mp_change > 5:
            # Power setting changed significantly - reset peaks
            state.peaks_valid = False
            state.leaning_active = False
            state.peak_egts = [0, 0, 0, 0]
            state.degrees_from_peak = [0, 0, 0, 0]
            log(f"Peak tracking reset: power change (RPM: {rpm_change:.1f}%, MP: {mp_change:.1f}%)")

    # Detect leaning: fuel flow decreasing over 10 seconds
    if len(state.ff_history) >= 5:
        # Get fuel flow from 10 seconds ago (or oldest available)
        oldest_samples = [ff for t, ff in state.ff_history if current_time - t >= 8]
        if oldest_samples:
            old_ff = sum(oldest_samples) / len(oldest_samples)
            recent_samples = [ff for t, ff in state.ff_history if current_time - t <= 3]
            if recent_samples:
                new_ff = sum(recent_samples) / len(recent_samples)
                ff_change = old_ff - new_ff  # Positive = leaning (fuel flow decreasing)

                # Detect enrichment (fuel flow increased significantly)
                if ff_change < -1.0 and state.peaks_valid:
                    # Mixture enriched by >1 GPH - reset peaks
                    state.peaks_valid = False
                    state.leaning_active = False
                    state.peak_egts = [0, 0, 0, 0]
                    state.degrees_from_peak = [0, 0, 0, 0]
                    log(f"Peak tracking reset: mixture enriched (+{-ff_change:.1f} GPH)")

                # Detect leaning (fuel flow decreasing by at least 0.5 GPH over interval)
                elif ff_change >= 0.5:
                    if not state.leaning_active:
                        state.leaning_active = True
                        state.last_stable_rpm = rpm
                        state.last_stable_mp = mp
                        log(f"Leaning detected: FF dropping {ff_change:.1f} GPH")

    # During active leaning, track peaks
    if state.leaning_active:
        peaks_updated = False
        for i in range(4):
            if egts[i] > state.peak_egts[i]:
                state.peak_egts[i] = egts[i]
                peaks_updated = True

        if peaks_updated and not state.peaks_valid:
            state.peaks_valid = True
            log(f"Peak EGTs captured: {state.peak_egts}")

    # Calculate degrees from peak for each cylinder
    if state.peaks_valid:
        for i in range(4):
            if state.peak_egts[i] > 0:
                # Negative = lean of peak, Positive = rich of peak (but we're past peak)
                # Convention: show as negative when LOP
                state.degrees_from_peak[i] = egts[i] - state.peak_egts[i]
            else:
                state.degrees_from_peak[i] = 0
    else:
        state.degrees_from_peak = [0, 0, 0, 0]


def calculate_oat_from_altitude(pressure_alt_ft):
    """
    Calculate OAT from pressure altitude using ISA standard atmosphere.
    Returns temperature in Celsius.
    """
    return ISA_SEA_LEVEL_TEMP_C - (pressure_alt_ft * ISA_LAPSE_RATE)

def calculate_pressure_altitude(indicated_alt_ft, altimeter_inhg):
    """
    Calculate pressure altitude from indicated altitude and altimeter setting.
    Formula: PA = IA + (29.92 - altimeter) × 1000

    Args:
        indicated_alt_ft: GPS or indicated altitude in feet
        altimeter_inhg: Current altimeter setting in inHg (e.g., 29.92)

    Returns: Pressure altitude in feet
    """
    return indicated_alt_ft + (29.92 - altimeter_inhg) * 1000

def calculate_density_altitude(pressure_alt_ft, oat_c):
    """
    Calculate density altitude from pressure altitude and OAT.
    Uses the formula: DA = PA + (120 * (OAT - ISA_temp))
    Returns density altitude in feet.
    """
    isa_temp_at_alt = ISA_SEA_LEVEL_TEMP_C - (pressure_alt_ft * ISA_LAPSE_RATE)
    temp_deviation = oat_c - isa_temp_at_alt
    return pressure_alt_ft + (120 * temp_deviation)

def calculate_tas(ground_speed, density_altitude):
    """
    Estimate TAS from ground speed and density altitude.
    TAS increases approximately 2% per 1000 ft of density altitude.
    Note: This is an approximation - actual TAS depends on wind.
    """
    if ground_speed <= 0:
        return 0
    # TAS correction factor: ~2% per 1000 ft DA
    correction = 1 + (density_altitude / 1000 * 0.02)
    return ground_speed * correction

def calculate_cruise_targets(density_altitude, percent_power):
    """
    Calculate optimal cruise targets based on density altitude.
    Returns (target_fuel_flow, target_power, target_mode).
    """
    # At higher density altitudes, recommend lower power settings
    # Below 8000 DA: 65% power LOP is optimal for economy
    # 8000-12000 DA: 55-60% power recommended
    # Above 12000 DA: 50-55% power recommended

    if density_altitude < 8000:
        target_pwr = 65
        target_mode = "LEAN"
    elif density_altitude < 12000:
        target_pwr = 60
        target_mode = "LEAN"
    else:
        target_pwr = 55
        target_mode = "LEAN"

    # Calculate target fuel flow at best economy (LOP)
    # HP = %power * max_hp / 100
    # FF = HP * BEST_ECONOMY_SFC
    target_hp = (target_pwr / 100) * ENGINE_MAX_HP
    target_ff = target_hp * BEST_ECONOMY_SFC

    return round(target_ff, 1), target_pwr, target_mode

def stratux_thread_func():
    """
    Background thread that polls Stratux HTTP API for GPS/baro data.
    Uses HTTP GET to /getSituation instead of websocket to avoid
    interfering with ForeFlight's GDL90 connection.

    In KML mode (desktop playback), reads GPS data from KML file instead,
    synchronized to the current EDM playback time.

    Reference: https://github.com/cyoung/stratux/blob/master/notes/app-vendor-integration.md
    """
    import urllib.request
    import urllib.error

    # Check for KML mode (desktop playback with GPS data from KML file)
    kml_file = CONFIG.get('KML_FILE')
    if kml_file:
        log(f"Stratux thread starting in KML mode: {kml_file}")
        kml_provider = KMLGPSProvider(kml_file)
        state.stratux_connected = True

        while not state.stop_event.is_set():
            try:
                # Get current playback time from latest EDM data
                with state.lock:
                    current_time = state.latest_data.get('time') if state.latest_data else None

                if current_time:
                    # Look up GPS data for this time
                    gps_data = kml_provider.get_data_at_time_str(current_time)

                    if gps_data:
                        with state.lock:
                            state.gps_altitude = gps_data.get('altitude_ft', 0)
                            state.ground_speed = gps_data.get('speed_kts', 0)

                            # Calculate pressure altitude from GPS alt and manual altimeter (if set)
                            if state.manual_altimeter is not None:
                                state.pressure_altitude = round(calculate_pressure_altitude(
                                    state.gps_altitude, state.manual_altimeter))
                            else:
                                # Use GPS altitude as pressure altitude approximation
                                state.pressure_altitude = state.gps_altitude

                            # Use manual OAT if set, otherwise calculate from standard atmosphere
                            if state.manual_oat is not None:
                                state.oat = state.manual_oat
                            else:
                                state.oat = round(calculate_oat_from_altitude(state.pressure_altitude), 1)

                            # Calculate density altitude
                            state.density_altitude = round(calculate_density_altitude(state.pressure_altitude, state.oat))

                            # Calculate TAS estimate
                            state.tas = round(calculate_tas(state.ground_speed, state.density_altitude))

                            # Calculate cruise targets
                            state.target_fuel_flow, state.target_power, state.target_mode = \
                                calculate_cruise_targets(state.density_altitude, state.percent_power)

            except Exception as e:
                log(f"KML GPS error: {e}")

            time.sleep(0.5)  # Poll faster in KML mode for smoother sync

        state.stratux_connected = False
        log("Stratux thread (KML mode) stopped")
        return

    # Normal Stratux HTTP polling mode
    stratux_url = CONFIG['STRATUX_HTTP_URL']
    poll_interval = CONFIG.get('STRATUX_POLL_INTERVAL', 1.0)  # seconds

    log(f"Stratux thread starting, polling {stratux_url}")

    consecutive_failures = 0
    max_failures_before_log = 5  # Only log after this many consecutive failures

    while not state.stop_event.is_set():
        try:
            # HTTP GET request with short timeout
            req = urllib.request.Request(stratux_url, headers={'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=2) as response:
                data = response.read().decode('utf-8')
                situation = json.loads(data)

                with state.lock:
                    if not state.stratux_connected:
                        log("Connected to Stratux HTTP API")
                    state.stratux_connected = True

                    # Extract Stratux data
                    state.gps_altitude = situation.get('GPSAltitudeMSL', 0)
                    state.ground_speed = situation.get('GPSGroundSpeed', 0)
                    # GPS position and attitude for CSV export
                    state.latitude = situation.get('GPSLatitude', None)
                    state.longitude = situation.get('GPSLongitude', None)
                    state.course = situation.get('GPSTrueCourse', None)
                    state.pitch = situation.get('AHRSPitch', None)
                    state.bank = situation.get('AHRSRoll', None)
                    state.acc_vert = situation.get('AHRSGLoad', None)

                    # Calculate pressure altitude
                    if state.manual_altimeter is not None:
                        # Use GPS altitude + manual altimeter setting
                        state.pressure_altitude = round(calculate_pressure_altitude(
                            state.gps_altitude, state.manual_altimeter))
                    else:
                        # Use Stratux baro altitude if available, else GPS
                        baro_alt = situation.get('BaroPressureAltitude', 0)
                        state.pressure_altitude = baro_alt if baro_alt > 0 else state.gps_altitude

                    # Use manual OAT if set, otherwise calculate from standard atmosphere
                    if state.manual_oat is not None:
                        state.oat = state.manual_oat
                    else:
                        state.oat = round(calculate_oat_from_altitude(state.pressure_altitude), 1)

                    # Calculate density altitude
                    state.density_altitude = round(calculate_density_altitude(state.pressure_altitude, state.oat))

                    # Calculate TAS estimate
                    state.tas = round(calculate_tas(state.ground_speed, state.density_altitude))

                    # Calculate cruise targets
                    state.target_fuel_flow, state.target_power, state.target_mode = \
                        calculate_cruise_targets(state.density_altitude, state.percent_power)

                consecutive_failures = 0

        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            consecutive_failures += 1
            if state.stratux_connected:
                log(f"Stratux connection lost: {e}")
                state.stratux_connected = False
            elif consecutive_failures == max_failures_before_log:
                log(f"Stratux not available (will retry silently): {e}")

        except json.JSONDecodeError as e:
            log(f"Stratux JSON parse error: {e}")

        except Exception as e:
            log(f"Stratux unexpected error: {e}")

        # Wait before next poll; stop_event.wait() blocks until timeout or shutdown signal
        state.stop_event.wait(timeout=poll_interval)

    state.stratux_connected = False
    log("Stratux thread stopped")

def capture_thread_func():
    """Background thread that captures serial data or plays back from file."""
    playback_mode = CONFIG.get('PLAYBACK_MODE', False)
    out_file = None
    csv_file = None
    ser = None
    serial_module = None  # For reconnect in live mode

    def open_serial():
        """Open serial port with robust configuration."""
        nonlocal serial_module
        if serial_module is None:
            import serial as serial_module

        port = CONFIG['SERIAL_PORT']

        # Check if port exists before attempting open
        if not os.path.exists(port):
            raise serial_module.SerialException(f"Port {port} does not exist. Check USB connection.")

        ser = serial_module.Serial(
            port,
            CONFIG['BAUD_RATE'],
            timeout=0.5,  # 500ms timeout balances responsiveness vs CPU usage
            write_timeout=1,
            bytesize=serial_module.EIGHTBITS,
            parity=serial_module.PARITY_NONE,
            stopbits=serial_module.STOPBITS_ONE,
            xonxoff=False,  # No software flow control
            rtscts=False,   # No hardware flow control
            dsrdtr=False,   # Prevent DTR toggle from resetting device
        )
        state.serial_open_time = datetime.now()
        log(f"Serial opened: {port} @ {CONFIG['BAUD_RATE']} 8N1")
        return ser

    # Buffer for accumulating partial serial reads
    serial_read_buffer = b''

    def read_complete_line(ser):
        """Read from serial, returning only complete lines (ending with newline).

        This prevents truncated lines from timeout expiring mid-transmission.
        Accumulates partial reads in buffer until a complete line is available.
        """
        nonlocal serial_read_buffer

        while True:
            # Check if we have a complete line in buffer
            newline_pos = serial_read_buffer.find(b'\n')
            if newline_pos >= 0:
                # Extract complete line (including newline)
                line = serial_read_buffer[:newline_pos + 1]
                serial_read_buffer = serial_read_buffer[newline_pos + 1:]
                return line

            # No complete line yet - read more data
            if hasattr(ser, 'in_waiting') and ser.in_waiting > 0:
                # Read all available data at once (more efficient)
                chunk = ser.read(ser.in_waiting)
            else:
                # Blocking read with timeout
                chunk = ser.read(256)

            if not chunk:
                # Timeout with no data - return empty to allow loop iteration
                return b''

            serial_read_buffer += chunk

            # Safety: prevent unbounded buffer growth (corrupted stream)
            if len(serial_read_buffer) > 16384:
                state.buffer_overflows += 1
                log(f"Warning: Serial buffer overflow #{state.buffer_overflows}, discarding {len(serial_read_buffer)} bytes")
                serial_read_buffer = b''
                return b''

    try:
        if playback_mode:
            # Playback mode - read from captured file (no output file needed)
            playback_file = CONFIG.get('PLAYBACK_FILE')
            playback_rate = CONFIG.get('PLAYBACK_RATE', 1.0)
            log(f"Capture thread starting in PLAYBACK mode: {playback_file}")
            ser = FilePlaybackReader(playback_file, rate=playback_rate)
            state.serial_connected = True
            state.serial_warning = None
            log(f"Playback reader opened: {playback_file} at {playback_rate}x speed")
        else:
            # Live mode - read from serial port and write to file
            active_path = os.path.join(CONFIG['DATA_DIR'], CONFIG['ACTIVE_FILE'])
            log(f"Capture starting, output: {active_path}")
            ser = open_serial()
            state.serial_connected = True
            state.serial_warning = None
            state.last_serial_error = None
            state.empty_read_count = 0
            state.bytes_received = 0
            state.lines_received = 0
            state.parse_errors = 0
            state.buffer_overflows = 0
            # Use line buffering (buffering=1) for efficient streaming writes
            out_file = open(active_path, 'w', buffering=1)

        # Open CSV file for server-side flight recording (both live and playback)
        csv_path = os.path.join(CONFIG['DATA_DIR'], CONFIG['ACTIVE_CSV'])
        csv_file = open(csv_path, 'w', buffering=1)
        csv_file.write(CSV_HEADER + '\n')
        state.csv_points = 0
        last_csv_time = 0  # For 1Hz throttling

        state.capture_start_time = datetime.now()
        state.last_data_time = time.time()

        lines_read = 0
        lines_parsed = 0
        consecutive_empty = 0  # Track consecutive empty reads
        last_warning_time = 0  # Avoid spamming logs

        while not state.stop_event.is_set():
            try:
                # Track if data was waiting before read (for diagnostic)
                data_was_waiting = hasattr(ser, 'in_waiting') and ser.in_waiting > 0

                # Read line - use buffered reader for live mode to prevent truncation
                if playback_mode:
                    # Playback mode uses FilePlaybackReader's readline with timing
                    line = ser.readline()
                else:
                    # Live mode uses buffered reader to ensure complete lines
                    line = read_complete_line(ser)

                if line:
                    lines_read += 1
                    state.bytes_received += len(line)
                    state.lines_received = lines_read
                    line_str = line.decode('utf-8', errors='ignore')

                    # Only write to file in live mode
                    if out_file:
                        out_file.write(line_str)
                        # Flush periodically (every 100 lines) instead of every line
                        # to avoid blocking serial reads at 6Hz data rate
                        if lines_read % 100 == 0:
                            out_file.flush()

                    # Parse for live display
                    parsed = parse_line(line_str)
                    if parsed:
                        lines_parsed += 1
                    else:
                        state.parse_errors += 1
                    if parsed:
                        # Calculate engine parameters
                        rpm = parsed.get('RPM', 0)
                        mp = parsed.get('MP', 0)
                        fuel_flow = parsed.get('Fuel_Flow', 0)
                        edm_timestamp = parsed.get('edm_timestamp', 0)

                        percent_power, deviation, mode, sfc = calculate_engine_parameters(rpm, mp, fuel_flow, edm_timestamp)

                        # Check for sticky valve during warmup
                        check_sticky_valve(
                            parsed.get('EGT1', 0),
                            parsed.get('EGT2', 0),
                            parsed.get('EGT3', 0),
                            parsed.get('EGT4', 0),
                            rpm
                        )

                        # Track per-cylinder peak EGT during leaning
                        update_peak_tracking(
                            parsed.get('EGT1', 0),
                            parsed.get('EGT2', 0),
                            parsed.get('EGT3', 0),
                            parsed.get('EGT4', 0),
                            fuel_flow,
                            rpm,
                            mp
                        )

                        with state.lock:
                            state.latest_data = parsed
                            state.data_count += 1
                            state.percent_power = percent_power
                            state.rop_lop_percent = deviation
                            state.rop_lop_mode = mode
                            state.sfc = sfc

                            # Add to history with timestamp
                            history_entry = {
                                'timestamp': time.time(),
                                'EGT1': parsed.get('EGT1', 0),
                                'EGT2': parsed.get('EGT2', 0),
                                'EGT3': parsed.get('EGT3', 0),
                                'EGT4': parsed.get('EGT4', 0),
                                'CHT1': parsed.get('CHT1', 0),
                                'CHT2': parsed.get('CHT2', 0),
                                'CHT3': parsed.get('CHT3', 0),
                                'CHT4': parsed.get('CHT4', 0),
                            }
                            state.history.append(history_entry)

                        # Update fuel tracker
                        if state.fuel_tracker:
                            ground_speed = state.ground_speed  # From Stratux or KML
                            state.fuel_tracker.update(
                                fuel_flow=fuel_flow,
                                edm_timestamp=edm_timestamp,
                                ground_speed=ground_speed,
                                rpm=rpm,
                                mp=mp,
                                fuel_total=parsed.get('Fuel_Remaining', 0),
                                fuel_left=parsed.get('Fuel_Left', 0),
                                fuel_right=parsed.get('Fuel_Right', 0)
                            )

                        # Write CSV row at 1Hz (throttle from ~4Hz serial rate)
                        now_csv = time.time()
                        if csv_file and now_csv - last_csv_time >= 1.0:
                            last_csv_time = now_csv
                            d = parsed
                            t = d.get('time', '')
                            # Format time as 12-hour with AM/PM
                            time_12 = ''
                            if t:
                                parts = t.split(':')
                                if len(parts) == 3:
                                    h = int(parts[0])
                                    ampm = 'PM' if h >= 12 else 'AM'
                                    h12 = h % 12 or 12
                                    time_12 = f"{h12}:{parts[1]}:{parts[2]} {ampm}"
                            egts = [d.get('EGT1', 0), d.get('EGT2', 0), d.get('EGT3', 0), d.get('EGT4', 0)]
                            chts = [d.get('CHT1', 0), d.get('CHT2', 0), d.get('CHT3', 0), d.get('CHT4', 0)]
                            egts_pos = [v for v in egts if v > 0]
                            chts_pos = [v for v in chts if v > 0]
                            egt_spread = max(egts_pos) - min(egts_pos) if egts_pos else 0
                            cht_spread = max(chts_pos) - min(chts_pos) if chts_pos else 0
                            max_egt = max(egts_pos) if egts_pos else 0
                            now_dt = datetime.now()
                            csv_row = ','.join(str(v) for v in [
                                time_12, d.get('MP', 0), d.get('Oil_Temp', 0), d.get('Oil_Press', 0),
                                d.get('Fuel_Press', 0), d.get('Volts', 0), d.get('Amps', 0),
                                d.get('RPM', 0), d.get('Fuel_Flow', 0), d.get('Fuel_Remaining', 0),
                                d.get('Fuel_Left', 0), d.get('Fuel_Right', 0), d.get('Carb_Temp', 0),
                                d.get('GP2', ''), d.get('GP3', ''), d.get('Thermo', 0),
                                d.get('EGT1', 0), d.get('EGT2', 0), d.get('EGT3', 0), d.get('EGT4', 0),
                                d.get('CHT1', 0), d.get('CHT2', 0), d.get('CHT3', 0), d.get('CHT4', 0),
                                now_dt.strftime('%Y-%m-%d'), time_12,
                                state.longitude or '', state.latitude or '',
                                state.gps_altitude or 0, state.ground_speed or 0,
                                f"{state.bank:.2f}" if state.bank is not None else '',
                                f"{state.pitch:.2f}" if state.pitch is not None else '',
                                state.acc_vert or '',
                                round(state.course) if state.course is not None else '',
                                egt_spread, cht_spread, max_egt,
                                percent_power if rpm > 0 else '',
                                mode if rpm > 0 else '',
                                deviation if rpm > 0 else '',
                                sfc if rpm > 0 else ''
                            ])
                            csv_file.write(csv_row + '\n')
                            state.csv_points += 1

                        # Clear warning and reset counters on successful data
                        state.last_data_time = time.time()
                        consecutive_empty = 0
                        if state.serial_warning:
                            state.serial_warning = None
                            log("Serial connection restored - data flowing normally")

                else:
                    # Empty read - handle differently for playback vs live mode
                    if playback_mode:
                        # EOF in playback mode - stop the loop
                        log("Playback: End of data reached")
                        break
                    else:
                        # Live mode - empty read, check for issues
                        consecutive_empty += 1
                        state.empty_read_count += 1
                        now = time.time()
                        time_since_data = now - state.last_data_time if state.last_data_time else 0

                        # Detect "ready but no data" condition
                        if data_was_waiting:
                            warning_msg = "Device reports ready but produced no data (possible disconnect or port conflict)"
                            if now - last_warning_time > 5:  # Log at most every 5 seconds
                                log(f"WARNING: {warning_msg}")
                                last_warning_time = now
                            state.serial_warning = warning_msg

                        # Detect extended data timeout (no data for 5+ seconds)
                        elif time_since_data > 5:
                            warning_msg = f"No data received for {int(time_since_data)} seconds"
                            if now - last_warning_time > 5:
                                log(f"WARNING: {warning_msg}")
                                last_warning_time = now
                            state.serial_warning = warning_msg

                        # Attempt reconnect after 10 consecutive empty reads with "ready but no data"
                        if consecutive_empty >= 10 and data_was_waiting:
                            log("Attempting serial port reconnect...")
                            try:
                                ser.close()
                                time.sleep(0.5)
                                ser = open_serial()
                                state.reconnect_count += 1
                                consecutive_empty = 0
                                log(f"Serial port reconnected (attempt #{state.reconnect_count})")
                            except Exception as reconnect_err:
                                err_msg = str(reconnect_err)
                                log(f"Reconnect failed: {err_msg}")
                                state.serial_warning = f"Reconnect failed: {err_msg}"
                                state.last_serial_error = err_msg
                                time.sleep(2)  # Wait before retrying

            except Exception as e:
                state.last_error = str(e)
                state.last_serial_error = str(e)
                log(f"Capture loop error: {e}")
                time.sleep(0.1)

        log("Capture thread stopped normally")

    except Exception as e:
        err_msg = str(e)
        log(f"Capture error: {err_msg}")
        state.last_error = err_msg
        state.last_serial_error = err_msg
        state.serial_connected = False

    finally:
        if ser:
            ser.close()
        if out_file:
            out_file.flush()  # Ensure all data written before close
            out_file.close()
        if csv_file:
            csv_file.flush()
            csv_file.close()

    state.capturing = False

def start_capture():
    """Start the capture thread."""
    if state.capturing:
        return {'success': False, 'message': 'Already capturing'}

    # Check for orphan active file
    active_path = os.path.join(CONFIG['DATA_DIR'], CONFIG['ACTIVE_FILE'])
    if os.path.exists(active_path):
        # Rename orphan file
        orphan_name = f"capture_orphan_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
        orphan_path = os.path.join(CONFIG['DATA_DIR'], orphan_name)
        os.rename(active_path, orphan_path)
        log(f"Moved orphan file to {orphan_name}")

    state.stop_event.clear()
    state.capturing = True
    state.data_count = 0
    state.last_error = None
    state.capture_thread = threading.Thread(target=capture_thread_func, daemon=True)
    state.capture_thread.start()

    log("Capture started")
    return {'success': True, 'message': 'Capture started'}

def stop_capture():
    """Stop capture and rename file with timestamp."""
    if not state.capturing:
        return {'success': False, 'message': 'Not capturing'}

    state.stop_event.set()
    if state.capture_thread:
        state.capture_thread.join(timeout=5)

    state.capturing = False

    timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
    csv_filename = None

    # Rename stream file with timestamp
    active_path = os.path.join(CONFIG['DATA_DIR'], CONFIG['ACTIVE_FILE'])
    if os.path.exists(active_path):
        file_size = os.path.getsize(active_path)
        if file_size > 0:
            new_name = f"stream_{timestamp}.txt"
            new_path = os.path.join(CONFIG['DATA_DIR'], new_name)

            # Don't overwrite existing
            counter = 1
            while os.path.exists(new_path):
                new_name = f"stream_{timestamp}_{counter}.txt"
                new_path = os.path.join(CONFIG['DATA_DIR'], new_name)
                counter += 1

            os.rename(active_path, new_path)
            log(f"Capture saved: {new_name} ({file_size} bytes)")
        else:
            os.remove(active_path)

    # Rename CSV file with same timestamp
    csv_active_path = os.path.join(CONFIG['DATA_DIR'], CONFIG['ACTIVE_CSV'])
    if os.path.exists(csv_active_path):
        csv_size = os.path.getsize(csv_active_path)
        if csv_size > len(CSV_HEADER) + 2:  # More than just the header
            csv_filename = f"flight_{timestamp}.csv"
            csv_new_path = os.path.join(CONFIG['DATA_DIR'], csv_filename)
            counter = 1
            while os.path.exists(csv_new_path):
                csv_filename = f"flight_{timestamp}_{counter}.csv"
                csv_new_path = os.path.join(CONFIG['DATA_DIR'], csv_filename)
                counter += 1
            os.rename(csv_active_path, csv_new_path)
            log(f"CSV saved: {csv_filename} ({state.csv_points} points)")
        else:
            os.remove(csv_active_path)

    result = {'success': True, 'message': 'Capture stopped'}
    if csv_filename:
        result['csv_filename'] = csv_filename
        result['csv_points'] = state.csv_points
    return result

def get_files():
    """Get list of captured files, sorted by modification time (newest first)."""
    files = []
    for pattern in ['stream_*.txt', 'flight_*.csv']:
        for path in glob.glob(os.path.join(CONFIG['DATA_DIR'], pattern)):
            name = os.path.basename(path)
            size = os.path.getsize(path)
            mtime_ts = os.path.getmtime(path)
            mtime = datetime.fromtimestamp(mtime_ts).strftime('%Y-%m-%d %H:%M')
            files.append({'name': name, 'size': size, 'modified': mtime, 'mtime_ts': mtime_ts})
    # Sort by modification time, newest first
    files.sort(key=lambda x: x['mtime_ts'], reverse=True)
    # Remove internal timestamp before returning
    for f in files:
        del f['mtime_ts']
    return files

def get_status():
    """Get current status."""
    with state.lock:
        data = state.latest_data.copy()
        percent_power = state.percent_power
        rop_lop_pct = state.rop_lop_percent
        rop_lop_mode = state.rop_lop_mode
        sfc = state.sfc
        # Stratux data
        stratux_connected = state.stratux_connected
        gps_altitude = state.gps_altitude
        pressure_altitude = state.pressure_altitude
        ground_speed = state.ground_speed
        oat = state.oat
        density_altitude = state.density_altitude
        tas = state.tas
        target_fuel_flow = state.target_fuel_flow
        target_power = state.target_power
        target_mode = state.target_mode
        # GPS position/attitude for CSV export
        latitude = state.latitude
        longitude = state.longitude
        course = state.course
        pitch = state.pitch
        bank = state.bank
        acc_vert = state.acc_vert
        # Sticky valve alert
        sticky_valve_alert = state.sticky_valve_alert
        sticky_valve_dismissed = state.sticky_valve_dismissed
        # Serial connection health
        serial_warning = state.serial_warning
        # Peak EGT tracking
        degrees_from_peak = state.degrees_from_peak.copy()
        peaks_valid = state.peaks_valid

    duration = ''
    if state.capture_start_time and state.capturing:
        elapsed = datetime.now() - state.capture_start_time
        minutes = int(elapsed.total_seconds() // 60)
        seconds = int(elapsed.total_seconds() % 60)
        duration = f"{minutes:02d}:{seconds:02d}"

    return {
        'version': VERSION,
        'api_contract': PI_API_CONTRACT,
        'capabilities': PI_CAPABILITIES,
        'capturing': state.capturing,
        'serial_connected': state.serial_connected,
        'stratux_connected': stratux_connected,
        'data_count': state.data_count,
        'csv_points': state.csv_points,
        'duration': duration,
        'last_error': state.last_error,
        'data': data,
        'percent_power': percent_power,
        'rop_lop_percent': rop_lop_pct,
        'rop_lop_mode': rop_lop_mode,
        'sfc': sfc,
        # Flight data from Stratux
        'gps_altitude': gps_altitude,
        'pressure_altitude': pressure_altitude,
        'ground_speed': ground_speed,
        'oat': oat,
        'density_altitude': density_altitude,
        'tas': tas,
        'target_fuel_flow': target_fuel_flow,
        'target_power': target_power,
        'target_mode': target_mode,
        # GPS position/attitude for CSV export
        'latitude': latitude,
        'longitude': longitude,
        'course': course,
        'pitch': pitch,
        'bank': bank,
        'acc_vert': acc_vert,
        # Sticky valve alert
        'sticky_valve_alert': sticky_valve_alert,
        'sticky_valve_dismissed': sticky_valve_dismissed,
        # Serial connection health
        'serial_warning': serial_warning,
        # Peak EGT tracking (per-cylinder degrees from peak)
        'degrees_from_peak': degrees_from_peak,
        'peaks_valid': peaks_valid,
        # Manual ATIS values
        'manual_altimeter': state.manual_altimeter,
        'manual_oat': state.manual_oat,
        # Fuel tracking
        'fuel': state.fuel_tracker.get_status() if state.fuel_tracker else None,
    }

def get_diagnostics():
    """Get diagnostic info for troubleshooting serial issues."""
    port = CONFIG['SERIAL_PORT']

    # Check port status
    port_exists = os.path.exists(port)
    port_readable = os.access(port, os.R_OK) if port_exists else False
    port_writable = os.access(port, os.W_OK) if port_exists else False

    # Get USB device info if available
    usb_devices = []
    try:
        import subprocess
        result = subprocess.run(['ls', '-la', '/dev/ttyUSB*'],
                                capture_output=True, text=True, timeout=2)
        if result.returncode == 0:
            usb_devices = result.stdout.strip().split('\n')
    except Exception:
        pass

    # Calculate uptime
    uptime_str = None
    if state.serial_open_time:
        uptime = datetime.now() - state.serial_open_time
        uptime_str = str(uptime).split('.')[0]  # Remove microseconds

    return {
        'version': VERSION,
        'api_contract': PI_API_CONTRACT,
        'capabilities': PI_CAPABILITIES,
        'config': {
            'port': port,
            'baud': CONFIG['BAUD_RATE'],
            'data_dir': CONFIG['DATA_DIR'],
            'is_aircraft': CONFIG['IS_AIRCRAFT'],
            'hostname': CONFIG['HOSTNAME'],
        },
        'port_status': {
            'exists': port_exists,
            'readable': port_readable,
            'writable': port_writable,
            'usb_devices': usb_devices,
        },
        'connection': {
            'serial_connected': state.serial_connected,
            'stratux_connected': state.stratux_connected,
            'open_time': state.serial_open_time.isoformat() if state.serial_open_time else None,
            'uptime': uptime_str,
            'reconnect_count': state.reconnect_count,
        },
        'counters': {
            'bytes_received': state.bytes_received,
            'lines_received': state.lines_received,
            'data_count': state.data_count,
            'parse_errors': state.parse_errors,
            'buffer_overflows': state.buffer_overflows,
        },
        'errors': {
            'last_error': state.last_error,
            'last_serial_error': state.last_serial_error,
            'serial_warning': state.serial_warning,
        },
        'timing': {
            'last_data_time': state.last_data_time,
            'capture_start': state.capture_start_time.isoformat() if state.capture_start_time else None,
        },
    }

def get_history(duration_minutes=30):
    """Get temperature history for plotting (downsampled for web).

    Args:
        duration_minutes: How many minutes of history to return (default 30)
    """
    with state.lock:
        history_list = list(state.history)

    if not history_list:
        return {'labels': [], 'egt': {}, 'cht': {}, 'duration': duration_minutes}

    # Filter to requested duration
    now = time.time()
    cutoff = now - (duration_minutes * 60)
    history_list = [h for h in history_list if h['timestamp'] >= cutoff]

    if not history_list:
        return {'labels': [], 'egt': {}, 'cht': {}, 'duration': duration_minutes}

    # Downsample to max 360 points for display
    max_points = 360
    if len(history_list) > max_points:
        step = len(history_list) // max_points
        history_list = history_list[::step]

    labels = []
    egt1, egt2, egt3, egt4 = [], [], [], []
    cht1, cht2, cht3, cht4 = [], [], [], []

    start_time = history_list[0]['timestamp'] if history_list else 0

    for entry in history_list:
        # Time as minutes:seconds from start
        elapsed = entry['timestamp'] - start_time
        mins = int(elapsed // 60)
        secs = int(elapsed % 60)
        labels.append(f"{mins}:{secs:02d}")

        egt1.append(entry['EGT1'])
        egt2.append(entry['EGT2'])
        egt3.append(entry['EGT3'])
        egt4.append(entry['EGT4'])
        cht1.append(entry['CHT1'])
        cht2.append(entry['CHT2'])
        cht3.append(entry['CHT3'])
        cht4.append(entry['CHT4'])

    return {
        'labels': labels,
        'egt': {'EGT1': egt1, 'EGT2': egt2, 'EGT3': egt3, 'EGT4': egt4},
        'cht': {'CHT1': cht1, 'CHT2': cht2, 'CHT3': cht3, 'CHT4': cht4},
        'duration': duration_minutes,
    }

# HTML Template - High contrast for sunlight
HTML_TEMPLATE = '''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link rel="manifest" href="./engine-monitor-manifest.json">
    <title>Engine Monitor</title>
    <script src="/static/chart.min.js"></script>
    <style>
        /* COMPACT SUNLIGHT-READABLE THEME
           Optimized for iPad portrait split-screen (upper window) with ForeFlight below
           - Maximum data density while maintaining sunlight readability
           - Compact gauges with abbreviated labels
           - High contrast colors
        */
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
            background: #FFFFF0;
            color: #000;
            padding: 6px;
            -webkit-font-smoothing: antialiased;
        }

        /* Compact header */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0 6px 0;
            margin-bottom: 6px;
            border-bottom: 2px solid #333;
        }
        .status {
            font-size: 18px;
            font-weight: 800;
            text-transform: uppercase;
        }
        .status.capturing { color: #006400; }
        .status.stopped { color: #CC0000; }
        .status.waiting { color: #CC6600; }

        .controls { display: flex; gap: 6px; }
        .btn {
            padding: 8px 14px;
            font-size: 15px;
            font-weight: 800;
            border: 2px solid;
            border-radius: 5px;
            cursor: pointer;
            text-transform: uppercase;
        }
        .btn-start { background: #90EE90; color: #000; border-color: #006400; }
        .btn-stop { background: #FFB6C1; color: #000; border-color: #CC0000; }
        .btn-help { background: #87CEEB; color: #000; border-color: #00008B; }
        .btn-shutdown { background: #FF6B6B; color: #FFF; border-color: #8B0000; font-weight: 800; }
        .btn:active { opacity: 0.7; }
        .btn:disabled { opacity: 0.3; }

        /* Primary gauges - 7 columns */
        .dashboard {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 4px;
            margin-bottom: 6px;
        }
        .gauge {
            background: #FFF;
            border: 2px solid #333;
            border-radius: 5px;
            padding: 4px;
            text-align: center;
        }
        .gauge-label {
            font-size: 12px;
            font-weight: 700;
            color: #333;
            text-transform: uppercase;
            line-height: 1;
        }
        .gauge-value {
            font-size: 28px;
            font-weight: 900;
            font-family: 'Courier New', monospace;
            color: #000;
            line-height: 1.1;
        }
        .gauge-unit {
            font-size: 11px;
            font-weight: 600;
            color: #555;
        }

        /* EGT/CHT rows - 4 columns each, side by side when possible */
        .temps-container {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            margin-bottom: 6px;
        }
        .temp-section { }
        .egt-row, .cht-row {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 3px;
        }
        .temp-gauge {
            background: #FFF;
            border: 2px solid #333;
            border-radius: 4px;
            padding: 3px;
            text-align: center;
        }
        .temp-gauge .gauge-label {
            font-size: 12px;
            font-weight: 700;
        }
        .temp-gauge .gauge-value {
            font-size: 24px;
            line-height: 1;
        }
        .temp-gauge .value-row {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 2px;
        }
        .trend-arrow {
            font-size: 18px;
            font-weight: 900;
        }
        .trend-up { color: #CC0000; }
        .trend-down { color: #006400; }
        .trend-stable { color: #888; }
        /* Degrees from peak display */
        .peak-delta {
            font-size: 13px;
            font-weight: 700;
            margin-top: 2px;
        }
        .peak-delta.lop { color: #0066CC; }  /* Blue for LOP */
        .peak-delta.rop { color: #CC6600; }  /* Orange for ROP (approaching peak) */
        .peak-delta.at-peak { color: #006400; }  /* Green at peak */
        .peak-delta.no-peak { color: #999; }  /* Gray when no peak data */

        /* ATIS input row */
        .atis-row {
            display: flex;
            gap: 8px;
            align-items: center;
            margin-bottom: 6px;
            padding: 4px 8px;
            background: #E8E8E8;
            border: 2px solid #666;
            border-radius: 5px;
        }
        .atis-row label {
            font-size: 12px;
            font-weight: 700;
            color: #333;
        }
        .atis-row input {
            width: 70px;
            padding: 4px 6px;
            font-size: 16px;
            font-weight: 700;
            border: 2px solid #333;
            border-radius: 4px;
            text-align: center;
        }
        .atis-row input.has-value {
            background: #90EE90;
            border-color: #006400;
        }
        .atis-row .atis-unit {
            font-size: 11px;
            color: #555;
            margin-left: -4px;
        }
        .atis-row .btn-clear {
            padding: 4px 8px;
            font-size: 11px;
            font-weight: 700;
            background: #FFB6C1;
            border: 2px solid #CC0000;
            border-radius: 4px;
            cursor: pointer;
        }

        .section-label {
            font-size: 13px;
            font-weight: 800;
            color: #333;
            text-transform: uppercase;
            margin-bottom: 2px;
        }

        /* Analysis row - 6 columns */
        .calcs-row {
            display: grid;
            grid-template-columns: repeat(6, 1fr);
            gap: 4px;
            margin-bottom: 6px;
        }
        .calc-gauge {
            background: #FFF;
            border: 2px solid #333;
            border-radius: 5px;
            padding: 4px;
            text-align: center;
        }
        .calc-gauge .gauge-value {
            font-size: 24px;
        }

        /* Flight data row - 5 columns */
        .flight-row {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 4px;
            margin-bottom: 6px;
        }

        /* Target row - 3 columns */
        .target-row {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 4px;
            margin-bottom: 6px;
        }

        /* Status colors - backgrounds for sunlight visibility */
        .rich-value {
            color: #000;
            background: #FFA500;
            padding: 1px 4px;
            border-radius: 3px;
        }
        .lean-value {
            color: #FFF;
            background: #0066CC;
            padding: 1px 4px;
            border-radius: 3px;
        }
        .target-value {
            color: #FFF;
            background: #006400;
            padding: 1px 4px;
            border-radius: 3px;
        }
        .stratux-disconnected {
            color: #666;
            background: #DDD;
            padding: 1px 4px;
            border-radius: 3px;
        }
        .peak-value {
            color: #000;
            background: #FFD700;
            padding: 1px 4px;
            border-radius: 3px;
        }
        .power-value { color: #000; }

        /* Temperature warnings */
        .temp-normal { color: #000; }
        .temp-caution {
            color: #000;
            background: #FFD700;
            padding: 1px 3px;
            border-radius: 3px;
        }
        .temp-warning {
            color: #FFF;
            background: #CC0000;
            padding: 1px 3px;
            border-radius: 3px;
        }

        /* Compact charts */
        .chart-container {
            background: #FFF;
            border: 2px solid #333;
            border-radius: 5px;
            padding: 6px;
            margin-bottom: 6px;
            height: 180px;
        }
        .chart-container canvas {
            width: 100% !important;
            height: 100% !important;
        }
        .chart-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
        }
        .section-title {
            font-size: 13px;
            font-weight: 800;
            color: #333;
            text-transform: uppercase;
        }
        .duration-select {
            background: #FFF;
            color: #000;
            border: 2px solid #333;
            border-radius: 4px;
            padding: 2px 6px;
            font-size: 13px;
            font-weight: 600;
        }

        /* Sticky valve warning - compact */
        .sticky-valve-warning {
            background: #FFD700;
            border: 3px solid #CC0000;
            color: #000;
            padding: 8px;
            border-radius: 5px;
            margin-bottom: 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .sticky-valve-warning .warning-text {
            font-size: 18px;
            font-weight: 900;
            color: #CC0000;
        }
        .sticky-valve-warning .warning-cylinder {
            color: #CC0000;
            font-size: 24px;
            font-weight: 900;
        }
        .sticky-valve-warning .dismiss-btn {
            background: #FFF;
            color: #000;
            border: 2px solid #333;
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 700;
        }

        /* Serial connection warning - red background */
        .serial-warning {
            background: #FF4444;
            border: 3px solid #CC0000;
            color: #FFF;
            padding: 8px;
            border-radius: 5px;
            margin-bottom: 6px;
            display: none;
            text-align: center;
        }
        .serial-warning .warning-text {
            font-size: 18px;
            font-weight: 900;
        }
        .serial-warning .warning-detail {
            font-size: 15px;
            margin-top: 3px;
        }

        .error-msg {
            background: #FFCCCC;
            color: #990000;
            padding: 6px;
            border: 2px solid #CC0000;
            border-radius: 4px;
            margin-bottom: 6px;
            font-weight: 700;
            font-size: 15px;
        }

        /* Fuel tracking styles */
        .fuel-row {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 4px;
            margin-bottom: 6px;
        }
        .fuel-gauge {
            background: #FFF;
            border: 2px solid #333;
            border-radius: 5px;
            padding: 4px;
            text-align: center;
        }
        .fuel-bar-container {
            background: #DDD;
            border: 2px solid #333;
            border-radius: 4px;
            height: 22px;
            position: relative;
            margin-bottom: 4px;
        }
        .fuel-bar {
            background: linear-gradient(90deg, #006400 0%, #90EE90 100%);
            height: 100%;
            border-radius: 2px;
            transition: width 0.5s ease;
        }
        .fuel-bar.low {
            background: linear-gradient(90deg, #CC6600 0%, #FFD700 100%);
        }
        .fuel-bar.critical {
            background: linear-gradient(90deg, #CC0000 0%, #FF6666 100%);
        }
        .fuel-bar-label {
            position: absolute;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
            font-weight: 700;
            font-size: 14px;
            color: #000;
            text-shadow: 0 0 2px #FFF;
        }
        .fuel-efficiency {
            text-align: center;
            font-size: 15px;
            font-weight: 600;
            margin-bottom: 4px;
            color: #333;
        }
        .btn-fuel {
            background: #87CEEB;
            color: #000;
            border: 2px solid #00008B;
            padding: 8px 16px;
            border-radius: 5px;
            font-weight: 800;
            width: 100%;
            margin-bottom: 6px;
            cursor: pointer;
        }
        .btn-fuel:active { opacity: 0.7; }
        .fuel-warning {
            background: #FFD700;
            border: 3px solid #CC6600;
            padding: 8px;
            border-radius: 5px;
            margin-bottom: 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .fuel-warning.critical {
            background: #FF6666;
            border-color: #CC0000;
        }
        .fuel-warning .warning-text {
            font-size: 18px;
            font-weight: 900;
            color: #CC0000;
        }

        /* Modal styles */
        .modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            z-index: 1000;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            padding-top: 20px;
        }
        .modal-content {
            background: #FFFFF0;
            border: 3px solid #333;
            border-radius: 8px;
            width: 90%;
            max-width: 400px;
            max-height: 90vh;
            overflow-y: auto;
        }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px;
            background: #333;
            color: #FFF;
            font-size: 18px;
            font-weight: 800;
        }
        .modal-close {
            background: #CC0000;
            color: #FFF;
            border: none;
            padding: 4px 10px;
            border-radius: 4px;
            font-weight: 700;
            cursor: pointer;
        }
        .modal-body {
            padding: 12px;
        }
        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            padding: 12px;
            border-top: 2px solid #CCC;
        }
        .form-row {
            margin-bottom: 10px;
        }
        .form-row label {
            display: block;
            font-size: 14px;
            font-weight: 700;
            color: #333;
            margin-bottom: 3px;
        }
        .form-row input[type="text"],
        .form-row input[type="number"],
        .form-row input[type="date"],
        .form-row input[type="time"] {
            width: 100%;
            padding: 8px;
            font-size: 18px;
            border: 2px solid #333;
            border-radius: 4px;
            background: #FFF;
        }
        .radio-label, .checkbox-label {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 15px;
            cursor: pointer;
        }
        .radio-label input, .checkbox-label input {
            width: 18px;
            height: 18px;
        }
        .fuel-preview {
            background: #E8E8E8;
            padding: 8px;
            border-radius: 4px;
            text-align: center;
            font-size: 15px;
            font-weight: 700;
            color: #333;
        }

        .version-badge {
            background: #333;
            color: #FFF;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 600;
            margin-left: 6px;
        }

        .time-display {
            font-size: 18px;
            font-weight: 800;
            font-family: 'Courier New', monospace;
            color: #000;
        }
        .duration {
            font-size: 14px;
            font-weight: 600;
            color: #444;
        }

        /* Files section - collapsible */
        .files-section {
            margin-top: 8px;
            border-top: 2px solid #333;
            padding-top: 6px;
        }
        .file-list {
            max-height: 100px;
            overflow-y: auto;
        }
        .file-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px;
            border-bottom: 1px solid #CCC;
            background: #FFF;
            font-size: 14px;
        }
        .file-name {
            color: #00008B;
            font-weight: 700;
        }
        .file-size {
            color: #444;
            font-size: 13px;
        }
        .btn-download {
            padding: 3px 8px;
            font-size: 13px;
            font-weight: 700;
            background: #87CEEB;
            color: #000;
            border: 2px solid #00008B;
            border-radius: 4px;
        }
        /* CSV Recording controls */
        .recording-section {
            background: #FFF;
            border: 2px solid #333;
            border-radius: 5px;
            padding: 6px;
            margin-bottom: 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
        }
        .recording-indicator {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .record-dot {
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: #999;
        }
        .record-dot.recording {
            background: #CC0000;
            animation: pulse 1s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .recording-info {
            font-size: 13px;
            font-weight: 600;
            color: #333;
        }
        .recording-buttons {
            display: flex;
            gap: 4px;
        }
        .btn-record {
            padding: 6px 10px;
            font-size: 13px;
            font-weight: 700;
            border: 2px solid;
            border-radius: 4px;
            cursor: pointer;
        }
        .btn-record.download {
            background: #87CEEB;
            border-color: #00008B;
            color: #000;
        }
        .auto-indicator {
            font-size: 11px;
            color: #CC6600;
            font-weight: 700;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <div id="status" class="status stopped">● STOPPED <span class="version-badge" id="version">v--</span></div>
            <div class="time-display" id="time">--:--:--</div>
            <div class="duration" id="duration"></div>
        </div>
        <div id="connectionBadge" style="padding:4px 10px; border-radius:4px; font-size:13px; font-weight:800; text-transform:uppercase; background:#90EE90; color:#006400; border:2px solid #006400;">Connected</div>
        <div class="controls">
            <button class="btn btn-start" id="btnStart" onclick="startCapture()">Start</button>
            <button class="btn btn-stop" id="btnStop" onclick="stopCapture()">Stop</button>
            <button class="btn btn-help" onclick="window.open('/help','_blank')">Help</button>
            <button class="btn btn-shutdown" onclick="shutdownApp()">Shutdown</button>
        </div>
    </div>

    <!-- CSV Recording Section (server-side) -->
    <div class="recording-section">
        <div class="recording-indicator">
            <span id="recordDot" class="record-dot"></span>
            <span id="recordStatus">Not Recording</span>
        </div>
        <div class="recording-info">
            <span id="recordCount">0</span> pts
            (<span id="recordDuration">0:00</span>)
        </div>
        <div class="recording-buttons">
            <button class="btn-record download" onclick="downloadActiveCSV()">CSV</button>
        </div>
    </div>

    <div id="error" class="error-msg" style="display:none;"></div>

    <div id="serialWarning" class="serial-warning">
        <div class="warning-text">SERIAL CONNECTION WARNING</div>
        <div class="warning-detail" id="serialWarningDetail"></div>
    </div>

    <div id="stickyValveWarning" class="sticky-valve-warning" style="display:none;">
        <div>
            <div class="warning-text">STICKY VALVE WARNING</div>
            <div>Cylinder <span id="stickyValveCylinder" class="warning-cylinder">?</span> EGT significantly below others</div>
            <div style="font-size:15px; color:#ccc; margin-top:5px;">Have mechanic check exhaust valve clearance (Lycoming SB 388C)</div>
        </div>
        <button class="dismiss-btn" onclick="dismissStickyValve()">Dismiss</button>
    </div>

    <div class="dashboard">
        <div class="gauge">
            <div class="gauge-label">RPM</div>
            <div class="gauge-value" id="rpm">----</div>
        </div>
        <div class="gauge">
            <div class="gauge-label">MAP</div>
            <div class="gauge-value" id="mp">--.-</div>
            <div class="gauge-unit">inHg</div>
        </div>
        <div class="gauge">
            <div class="gauge-label">FUEL FLOW</div>
            <div class="gauge-value" id="fuel">--.-</div>
            <div class="gauge-unit">GPH</div>
        </div>
        <div class="gauge">
            <div class="gauge-label">OIL TEMP</div>
            <div class="gauge-value" id="oilT">---</div>
            <div class="gauge-unit">°F</div>
        </div>
        <div class="gauge">
            <div class="gauge-label">OIL PRESS</div>
            <div class="gauge-value" id="oilP">--</div>
            <div class="gauge-unit">PSI</div>
        </div>
        <div class="gauge">
            <div class="gauge-label">VOLTS</div>
            <div class="gauge-value" id="volts">--.-</div>
        </div>
        <div class="gauge">
            <div class="gauge-label">CARB TEMP</div>
            <div class="gauge-value" id="carbTemp">---</div>
            <div class="gauge-unit">°F</div>
        </div>
    </div>

    <div class="section-title">ENGINE ANALYSIS</div>
    <div class="calcs-row">
        <div class="calc-gauge">
            <div class="gauge-label">% POWER</div>
            <div class="gauge-value" id="percentPower">--</div>
        </div>
        <div class="calc-gauge">
            <div class="gauge-label">MIXTURE</div>
            <div class="gauge-value" id="ropLopMode">---</div>
        </div>
        <div class="calc-gauge">
            <div class="gauge-label">DEVIATION %</div>
            <div class="gauge-value" id="ropLopPercent">--</div>
        </div>
        <div class="calc-gauge">
            <div class="gauge-label">BSFC (lb/HP/hr)</div>
            <div class="gauge-value" id="sfc">--</div>
        </div>
    </div>

    <div class="section-title">EGT (°F)</div>
    <div class="egt-row">
        <div class="temp-gauge"><div class="gauge-label">EGT 1</div><div class="value-row"><span class="gauge-value" id="egt1">----</span><span class="trend-arrow" id="egt1Trend"></span></div><div class="peak-delta no-peak" id="peak1">--</div></div>
        <div class="temp-gauge"><div class="gauge-label">EGT 2</div><div class="value-row"><span class="gauge-value" id="egt2">----</span><span class="trend-arrow" id="egt2Trend"></span></div><div class="peak-delta no-peak" id="peak2">--</div></div>
        <div class="temp-gauge"><div class="gauge-label">EGT 3</div><div class="value-row"><span class="gauge-value" id="egt3">----</span><span class="trend-arrow" id="egt3Trend"></span></div><div class="peak-delta no-peak" id="peak3">--</div></div>
        <div class="temp-gauge"><div class="gauge-label">EGT 4</div><div class="value-row"><span class="gauge-value" id="egt4">----</span><span class="trend-arrow" id="egt4Trend"></span></div><div class="peak-delta no-peak" id="peak4">--</div></div>
    </div>

    <div class="section-title">CHT (°F)</div>
    <div class="cht-row">
        <div class="temp-gauge"><div class="gauge-label">CHT 1</div><div class="value-row"><span class="gauge-value" id="cht1">---</span><span class="trend-arrow" id="cht1Trend"></span></div></div>
        <div class="temp-gauge"><div class="gauge-label">CHT 2</div><div class="value-row"><span class="gauge-value" id="cht2">---</span><span class="trend-arrow" id="cht2Trend"></span></div></div>
        <div class="temp-gauge"><div class="gauge-label">CHT 3</div><div class="value-row"><span class="gauge-value" id="cht3">---</span><span class="trend-arrow" id="cht3Trend"></span></div></div>
        <div class="temp-gauge"><div class="gauge-label">CHT 4</div><div class="value-row"><span class="gauge-value" id="cht4">---</span><span class="trend-arrow" id="cht4Trend"></span></div></div>
    </div>

    <div class="chart-header">
        <span class="section-title">EGT/CHT TREND</span>
        <select id="chartDuration" class="duration-select" onchange="updateCharts()">
            <option value="5">Last 5 min</option>
            <option value="10">Last 10 min</option>
            <option value="15">Last 15 min</option>
            <option value="30" selected>Last 30 min</option>
            <option value="60">Last 60 min</option>
            <option value="120">Last 2 hours</option>
        </select>
    </div>
    <div class="chart-container">
        <canvas id="egtChart"></canvas>
    </div>
    <div class="chart-container">
        <canvas id="chtChart"></canvas>
    </div>

    <div class="atis-row">
        <label>ATIS:</label>
        <label>Altimeter</label>
        <input type="text" id="atisAltimeter" placeholder="29.92" maxlength="5" inputmode="decimal">
        <span class="atis-unit">inHg</span>
        <label>OAT</label>
        <input type="text" id="atisOat" placeholder="15" maxlength="4" inputmode="numeric">
        <span class="atis-unit">°C</span>
        <button class="btn-clear" onclick="clearAtis()">Clear</button>
    </div>

    <div class="section-title">FLIGHT DATA</div>
    <div class="calcs-row">
        <div class="calc-gauge">
            <div class="gauge-label">ALT (MSL)</div>
            <div class="gauge-value" id="gpsAlt">-----</div>
            <div class="gauge-unit">ft</div>
        </div>
        <div class="calc-gauge">
            <div class="gauge-label">DENS ALT</div>
            <div class="gauge-value" id="densAlt">-----</div>
            <div class="gauge-unit">ft</div>
        </div>
        <div class="calc-gauge">
            <div class="gauge-label">OAT</div>
            <div class="gauge-value" id="oat">--</div>
            <div class="gauge-unit">°C</div>
        </div>
        <div class="calc-gauge">
            <div class="gauge-label">GND SPD</div>
            <div class="gauge-value" id="gndSpd">---</div>
            <div class="gauge-unit">kts</div>
        </div>
        <div class="calc-gauge">
            <div class="gauge-label">TAS</div>
            <div class="gauge-value" id="tas">---</div>
            <div class="gauge-unit">kts</div>
        </div>
    </div>

    <div class="section-title">CRUISE TARGETS</div>
    <div class="calcs-row">
        <div class="calc-gauge">
            <div class="gauge-label">TARGET FF</div>
            <div class="gauge-value target-value" id="targetFf">--.-</div>
            <div class="gauge-unit">GPH</div>
        </div>
        <div class="calc-gauge">
            <div class="gauge-label">TARGET PWR</div>
            <div class="gauge-value target-value" id="targetPwr">--</div>
            <div class="gauge-unit">%</div>
        </div>
        <div class="calc-gauge">
            <div class="gauge-label">TARGET MIX</div>
            <div class="gauge-value target-value" id="targetMode">---</div>
        </div>
    </div>

    <!-- Fuel Status Section -->
    <div class="section-title">FUEL STATUS</div>
    <div id="fuelWarning" class="fuel-warning" style="display:none;">
        <div class="warning-text" id="fuelWarningText">LOW FUEL</div>
        <button class="dismiss-btn" onclick="dismissFuelWarning()">Dismiss</button>
    </div>
    <div class="fuel-row">
        <div class="fuel-gauge">
            <div class="gauge-label">REMAINING</div>
            <div class="gauge-value" id="fuelRemaining">--.-</div>
            <div class="gauge-unit">GAL</div>
        </div>
        <div class="fuel-gauge">
            <div class="gauge-label">USED (FLIGHT)</div>
            <div class="gauge-value" id="fuelUsed">--.-</div>
            <div class="gauge-unit">GAL</div>
        </div>
        <div class="fuel-gauge">
            <div class="gauge-label">ENDURANCE</div>
            <div class="gauge-value" id="fuelEndurance">-:--</div>
            <div class="gauge-unit">H:MM</div>
        </div>
        <div class="fuel-gauge">
            <div class="gauge-label">RANGE</div>
            <div class="gauge-value" id="fuelRange">---</div>
            <div class="gauge-unit">NM</div>
        </div>
    </div>
    <div class="section-label">EDM FUEL GAUGES</div>
    <div class="fuel-row" style="grid-template-columns: repeat(3, 1fr);">
        <div class="fuel-gauge">
            <div class="gauge-label">LEFT TANK</div>
            <div class="gauge-value" id="edmFuelLeft">--.-</div>
            <div class="gauge-unit">GAL</div>
        </div>
        <div class="fuel-gauge">
            <div class="gauge-label">RIGHT TANK</div>
            <div class="gauge-value" id="edmFuelRight">--.-</div>
            <div class="gauge-unit">GAL</div>
        </div>
        <div class="fuel-gauge">
            <div class="gauge-label">TOTAL (EDM)</div>
            <div class="gauge-value" id="edmFuelTotal">--.-</div>
            <div class="gauge-unit">GAL</div>
        </div>
    </div>
    <div class="fuel-bar-container">
        <div class="fuel-bar" id="fuelBar" style="width:0%"></div>
        <span class="fuel-bar-label" id="fuelBarLabel">--% (--/-- gal)</span>
    </div>
    <div class="fuel-efficiency" id="fuelEfficiency">-- GPH @ -- kts = -- nm/gal</div>
    <button class="btn btn-fuel" onclick="openAddFuelModal()">+ ADD FUEL</button>

    <!-- Add Fuel Modal -->
    <div id="addFuelModal" class="modal" style="display:none;">
        <div class="modal-content">
            <div class="modal-header">
                <span>ADD FUEL</span>
                <button class="modal-close" onclick="closeAddFuelModal()">X</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <label>Date</label>
                    <input type="date" id="fuelDate">
                </div>
                <div class="form-row">
                    <label>Time</label>
                    <input type="time" id="fuelTime">
                </div>
                <div class="form-row">
                    <label>Airport</label>
                    <input type="text" id="fuelAirport" maxlength="4" placeholder="KXXX" style="text-transform:uppercase;">
                </div>
                <div class="form-row">
                    <label>Gallons</label>
                    <input type="number" id="fuelGallons" step="0.1" min="0" max="50">
                </div>
                <div class="form-row">
                    <label>Price/gal</label>
                    <input type="number" id="fuelPrice" step="0.01" min="0" placeholder="Optional">
                </div>
                <div class="form-row">
                    <label class="radio-label">
                        <input type="radio" name="fuelMode" value="add" checked> Add gallons to current
                    </label>
                </div>
                <div class="form-row">
                    <label class="radio-label">
                        <input type="radio" name="fuelMode" value="set"> Set total fuel to this amount
                    </label>
                </div>
                <div class="form-row">
                    <label class="checkbox-label">
                        <input type="checkbox" id="includeCalibration" checked> Include in K-factor calibration
                    </label>
                </div>
                <div class="form-row">
                    <label>Notes</label>
                    <input type="text" id="fuelNotes" placeholder="Optional notes">
                </div>
                <div class="fuel-preview" id="fuelPreview">Current: -- gal → After: -- gal</div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-stop" onclick="closeAddFuelModal()">CANCEL</button>
                <button class="btn btn-start" onclick="submitAddFuel()">SAVE</button>
            </div>
        </div>
    </div>

    <div class="files-section">
        <div class="section-title">Captured Files</div>
        <div class="file-list" id="fileList">Loading...</div>
    </div>

    <div class="files-section" style="margin-top:10px;">
        <div class="section-title">Upload Script Files</div>
        <div class="upload-section">
            <input type="file" id="uploadInput" multiple accept=".py,.js,.html,.css,.json,.md" style="display:none;">
            <button class="btn btn-start" onclick="document.getElementById('uploadInput').click()">SELECT FILES</button>
            <span id="uploadStatus" style="margin-left:10px;font-size:11px;"></span>
        </div>
        <div id="uploadPreview" style="font-size:11px;color:#666;margin-top:6px;"></div>
        <button id="uploadBtn" class="btn btn-stop" onclick="uploadFiles()" style="display:none;margin-top:8px;">UPLOAD</button>
        <div style="font-size:10px;color:#999;margin-top:6px;">
            Allowed: .py, .js, .html, .css, .json, .md
        </div>
    </div>

    <script>
        // Download active or most recent CSV from server
        function downloadActiveCSV() {
            // Try active CSV first (during capture), fall back to most recent flight CSV
            const a = document.createElement('a');
            a.href = '/download/' + encodeURIComponent('flight_active.csv');
            a.download = 'flight_active.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }

        // Offline tracking
        let isOffline = false;
        let statusPollId = null;
        let filesPollId = null;
        let chartsPollId = null;

        function updateConnectionBadge(offline) {
            const badge = document.getElementById('connectionBadge');
            if (!badge) return;
            if (offline) {
                badge.textContent = 'Offline';
                badge.style.background = '#FFB6C1';
                badge.style.color = '#CC0000';
                badge.style.borderColor = '#CC0000';
            } else {
                badge.textContent = 'Connected';
                badge.style.background = '#90EE90';
                badge.style.color = '#006400';
                badge.style.borderColor = '#006400';
            }
        }

        function setOfflineState(offline) {
            if (isOffline === offline) return;
            isOffline = offline;
            updateConnectionBadge(offline);

            // Adjust poll intervals: slow down when offline, speed up when back online
            clearInterval(statusPollId);
            clearInterval(filesPollId);
            clearInterval(chartsPollId);
            if (offline) {
                statusPollId = setInterval(updateStatus, 5000);
                // Don't poll files or charts when offline
            } else {
                statusPollId = setInterval(updateStatus, 1000);
                filesPollId = setInterval(updateFiles, 10000);
                chartsPollId = setInterval(updateCharts, 2000);
            }
        }

        // Service Worker registration for offline support
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./service-worker.js')
                    .then(reg => console.log('Service Worker registered, scope:', reg.scope))
                    .catch(err => console.error('Service Worker registration failed:', err));
            });
        }

        // Flight Data Recording is now server-side (in capture thread)

        // Trend calculation: compare current value to value from 3 seconds ago
        // Optimized from actual flight data analysis for mag check detection
        const BUFFER_SIZE = 30;  // 30 seconds of history at 1Hz API updates
        const LOOKBACK = 3;      // Compare to value from 3 seconds ago (responsive for mag check)
        const EGT_THRESHOLD = 20; // Degrees change to show EGT trend (98% stable during cruise)
        const CHT_THRESHOLD = 3;  // Degrees change to show CHT trend

        const valueBuffers = {
            EGT1: [], EGT2: [], EGT3: [], EGT4: [],
            CHT1: [], CHT2: [], CHT3: [], CHT4: []
        };

        function updateTrend(id, currentVal, isEGT) {
            const el = document.getElementById(id + 'Trend');
            if (!el) return;

            const buffer = valueBuffers[id.toUpperCase()];
            const threshold = isEGT ? EGT_THRESHOLD : CHT_THRESHOLD;

            // Add current value to buffer
            if (currentVal && currentVal > 0) {
                buffer.push(currentVal);
                if (buffer.length > BUFFER_SIZE) {
                    buffer.shift(); // Remove oldest value
                }
            }

            // Need enough samples to compare (LOOKBACK + 1)
            if (buffer.length <= LOOKBACK || currentVal === 0) {
                el.textContent = '';
                el.className = 'trend-arrow';
                return;
            }

            // Compare current value to value from LOOKBACK seconds ago
            const oldValue = buffer[buffer.length - 1 - LOOKBACK];
            const diff = currentVal - oldValue;

            if (diff > threshold) {
                el.textContent = '\u25B2'; // Up arrow - rising
                el.className = 'trend-arrow trend-up';
            } else if (diff < -threshold) {
                el.textContent = '\u25BC'; // Down arrow - falling
                el.className = 'trend-arrow trend-down';
            } else {
                el.textContent = '\u25CF'; // Dot for stable
                el.className = 'trend-arrow trend-stable';
            }
        }

        function updateStatus() {
            fetch('/api/status')
                .then(r => r.json())
                .then(data => {
                    // Update server-side CSV recording display
                    const dot = document.getElementById('recordDot');
                    const recStatus = document.getElementById('recordStatus');
                    const recCount = document.getElementById('recordCount');
                    const recDuration = document.getElementById('recordDuration');
                    if (dot) dot.className = 'record-dot' + (data.capturing ? ' recording' : '');
                    if (recStatus) recStatus.textContent = data.capturing ? 'Recording CSV' : 'Not Recording';
                    if (recCount) recCount.textContent = data.csv_points || 0;
                    if (recDuration) recDuration.textContent = data.duration || '0:00';

                    const statusEl = document.getElementById('status');
                    const btnStart = document.getElementById('btnStart');
                    const btnStop = document.getElementById('btnStop');

                    const versionBadge = data.version ? '<span class="version-badge">v' + data.version + '</span>' : '';
                    if (data.capturing) {
                        statusEl.innerHTML = '● CAPTURING ' + versionBadge;
                        statusEl.className = 'status capturing';
                        btnStart.disabled = true;
                        btnStop.disabled = false;
                    } else {
                        statusEl.innerHTML = '● STOPPED ' + versionBadge;
                        statusEl.className = 'status stopped';
                        btnStart.disabled = false;
                        btnStop.disabled = true;
                    }

                    document.getElementById('duration').textContent =
                        data.duration ? `Duration: ${data.duration}` : '';

                    if (data.last_error) {
                        document.getElementById('error').style.display = 'block';
                        document.getElementById('error').textContent = data.last_error;
                    } else {
                        document.getElementById('error').style.display = 'none';
                    }

                    // Serial connection warning
                    const serialWarning = document.getElementById('serialWarning');
                    if (data.serial_warning) {
                        document.getElementById('serialWarningDetail').textContent = data.serial_warning;
                        serialWarning.style.display = 'block';
                    } else {
                        serialWarning.style.display = 'none';
                    }

                    // Sticky valve warning
                    const stickyWarning = document.getElementById('stickyValveWarning');
                    if (data.sticky_valve_alert && !data.sticky_valve_dismissed) {
                        document.getElementById('stickyValveCylinder').textContent = data.sticky_valve_alert;
                        stickyWarning.style.display = 'flex';
                    } else {
                        stickyWarning.style.display = 'none';
                    }

                    // Update gauges
                    const d = data.data;
                    if (d && Object.keys(d).length > 0) {
                        document.getElementById('time').textContent = d.time || '--:--:--';
                        document.getElementById('rpm').textContent = d.RPM || '----';
                        document.getElementById('mp').textContent = d.MP ? d.MP.toFixed(1) : '--.-';
                        document.getElementById('fuel').textContent = d.Fuel_Flow ? d.Fuel_Flow.toFixed(1) : '--.-';
                        document.getElementById('oilT').textContent = d.Oil_Temp || '---';
                        document.getElementById('oilP').textContent = d.Oil_Press || '--';
                        document.getElementById('volts').textContent = d.Volts ? d.Volts.toFixed(1) : '--.-';
                        document.getElementById('carbTemp').textContent = d.Carb_Temp || '---';

                        // Update EGTs with trend arrows (10-second rolling average)
                        document.getElementById('egt1').textContent = d.EGT1 || '----';
                        document.getElementById('egt2').textContent = d.EGT2 || '----';
                        document.getElementById('egt3').textContent = d.EGT3 || '----';
                        document.getElementById('egt4').textContent = d.EGT4 || '----';
                        updateTrend('egt1', d.EGT1, true);
                        updateTrend('egt2', d.EGT2, true);
                        updateTrend('egt3', d.EGT3, true);
                        updateTrend('egt4', d.EGT4, true);

                        // Update degrees from peak for each cylinder
                        const peakDeltas = data.degrees_from_peak || [0, 0, 0, 0];
                        const peaksValid = data.peaks_valid || false;
                        for (let i = 1; i <= 4; i++) {
                            const peakEl = document.getElementById('peak' + i);
                            const delta = peakDeltas[i - 1];
                            peakEl.className = 'peak-delta';
                            if (!peaksValid) {
                                peakEl.textContent = '--';
                                peakEl.classList.add('no-peak');
                            } else if (delta === 0) {
                                peakEl.textContent = 'PEAK';
                                peakEl.classList.add('at-peak');
                            } else if (delta < 0) {
                                peakEl.textContent = delta + '°';
                                peakEl.classList.add('lop');
                            } else {
                                peakEl.textContent = '+' + delta + '°';
                                peakEl.classList.add('rop');
                            }
                        }

                        // Update CHTs with trend arrows (10-second rolling average)
                        document.getElementById('cht1').textContent = d.CHT1 || '---';
                        document.getElementById('cht2').textContent = d.CHT2 || '---';
                        document.getElementById('cht3').textContent = d.CHT3 || '---';
                        document.getElementById('cht4').textContent = d.CHT4 || '---';
                        updateTrend('cht1', d.CHT1, false);
                        updateTrend('cht2', d.CHT2, false);
                        updateTrend('cht3', d.CHT3, false);
                        updateTrend('cht4', d.CHT4, false);

                        // Color code CHTs
                        ['cht1','cht2','cht3','cht4'].forEach(id => {
                            const el = document.getElementById(id);
                            const val = parseInt(el.textContent);
                            el.className = 'gauge-value';
                            if (val > 400) el.classList.add('temp-warning');
                            else if (val > 380) el.classList.add('temp-caution');
                            else el.classList.add('temp-normal');
                        });
                    }

                    // Update percent power display (always show value)
                    const powerEl = document.getElementById('percentPower');
                    powerEl.textContent = (data.percent_power !== undefined ? data.percent_power.toFixed(0) : '0') + '%';
                    powerEl.className = 'gauge-value power-value';

                    // Update mixture mode and deviation displays (always show values)
                    const modeEl = document.getElementById('ropLopMode');
                    const pctEl = document.getElementById('ropLopPercent');
                    const sfcEl = document.getElementById('sfc');

                    modeEl.textContent = data.rop_lop_mode || '---';
                    modeEl.className = 'gauge-value';
                    if (data.rop_lop_mode === 'RICH') modeEl.classList.add('rich-value');
                    else if (data.rop_lop_mode === 'LEAN') modeEl.classList.add('lean-value');
                    else if (data.rop_lop_mode === 'PEAK') modeEl.classList.add('peak-value');

                    const pct = Math.abs(data.rop_lop_percent !== undefined ? data.rop_lop_percent : 0).toFixed(1);
                    pctEl.textContent = pct + '%';
                    pctEl.className = 'gauge-value';
                    if (data.rop_lop_mode === 'RICH') pctEl.classList.add('rich-value');
                    else if (data.rop_lop_mode === 'LEAN') pctEl.classList.add('lean-value');

                    sfcEl.textContent = (data.sfc !== undefined ? data.sfc : 0).toFixed(2);
                    sfcEl.className = 'gauge-value';
                    // Color code SFC - green for efficient, yellow for normal, red for high
                    if (data.sfc && data.sfc > 0) {
                        if (data.sfc < 0.42) sfcEl.classList.add('temp-normal');
                        else if (data.sfc < 0.50) sfcEl.classList.add('temp-caution');
                        else sfcEl.classList.add('temp-warning');
                    }

                    // Update flight data from Stratux
                    const stratuxClass = data.stratux_connected ? '' : 'stratux-disconnected';
                    const gpsAltEl = document.getElementById('gpsAlt');
                    const densAltEl = document.getElementById('densAlt');
                    const oatEl = document.getElementById('oat');
                    const gndSpdEl = document.getElementById('gndSpd');
                    const tasEl = document.getElementById('tas');

                    gpsAltEl.textContent = data.gps_altitude ? Math.round(data.gps_altitude) : '-----';
                    gpsAltEl.className = 'gauge-value ' + stratuxClass;
                    densAltEl.textContent = data.density_altitude ? Math.round(data.density_altitude) : '-----';
                    densAltEl.className = 'gauge-value ' + stratuxClass;
                    oatEl.textContent = data.oat !== undefined ? data.oat.toFixed(0) : '--';
                    // Highlight OAT if using manual ATIS value
                    oatEl.className = 'gauge-value ' + (data.manual_oat !== null ? '' : stratuxClass);
                    if (data.manual_oat !== null) oatEl.style.background = '#90EE90';
                    else oatEl.style.background = '';
                    gndSpdEl.textContent = data.ground_speed ? Math.round(data.ground_speed) : '---';
                    gndSpdEl.className = 'gauge-value ' + stratuxClass;
                    tasEl.textContent = data.tas ? Math.round(data.tas) : '---';
                    tasEl.className = 'gauge-value ' + stratuxClass;

                    // Update cruise targets
                    const targetFfEl = document.getElementById('targetFf');
                    const targetPwrEl = document.getElementById('targetPwr');
                    const targetModeEl = document.getElementById('targetMode');

                    targetFfEl.textContent = data.target_fuel_flow ? data.target_fuel_flow.toFixed(1) : '--.-';
                    targetFfEl.className = 'gauge-value target-value ' + stratuxClass;
                    targetPwrEl.textContent = data.target_power ? data.target_power + '%' : '--%';
                    targetPwrEl.className = 'gauge-value target-value ' + stratuxClass;
                    targetModeEl.textContent = data.target_mode || '---';
                    targetModeEl.className = 'gauge-value target-value lean-value ' + stratuxClass;

                    // Update fuel display
                    if (data.fuel) {
                        updateFuelDisplay(data.fuel);
                    }

                    // Sync ATIS input fields from server (only if user hasn't entered values)
                    const atisAltEl = document.getElementById('atisAltimeter');
                    const atisOatEl = document.getElementById('atisOat');
                    if (atisAltEl.value === '' && data.manual_altimeter !== null) {
                        atisAltEl.value = data.manual_altimeter;
                    }
                    if (atisOatEl.value === '' && data.manual_oat !== null) {
                        atisOatEl.value = data.manual_oat;
                    }
                    updateAtisStyle();
                    setOfflineState(false);
                })
                .catch(e => {
                    setOfflineState(true);
                });
        }

        function updateFiles() {
            if (isOffline) return;
            fetch('/api/files')
                .then(r => r.json())
                .then(files => {
                    const list = document.getElementById('fileList');
                    if (files.length === 0) {
                        list.innerHTML = '<div style="color:#666;padding:10px;">No captured files</div>';
                        return;
                    }
                    list.innerHTML = files.map(f => `
                        <div class="file-item">
                            <div>
                                <div class="file-name">${f.name}</div>
                                <div class="file-size">${(f.size/1024).toFixed(1)} KB - ${f.modified}</div>
                            </div>
                            <button class="btn-download" onclick="downloadFile('${f.name}')">Download</button>
                        </div>
                    `).join('');
                });
        }

        function startCapture() {
            fetch('/api/start', {method: 'POST'})
                .then(r => r.json())
                .then(data => {
                    if (!data.success) alert(data.message);
                    updateStatus();
                });
        }

        function triggerDownload(filename) {
            const a = document.createElement('a');
            a.href = '/download/' + encodeURIComponent(filename);
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }

        function stopCapture() {
            fetch('/api/stop', {method: 'POST'})
                .then(r => r.json())
                .then(data => {
                    // Auto-download the CSV
                    if (data.csv_filename) {
                        triggerDownload(data.csv_filename);
                    }
                    alert(data.message);
                    updateStatus();
                    updateFiles();
                });
        }

        function shutdownApp() {
            if (confirm('Shutdown the Engine Monitor app?\\n\\nYou will need to restart it manually or reboot the Raspberry Pi.')) {
                // Stop capture first to save and download CSV, then shutdown
                fetch('/api/stop', {method: 'POST'})
                    .then(r => r.json())
                    .then(data => {
                        if (data.csv_filename) {
                            triggerDownload(data.csv_filename);
                        }
                        // Brief delay to allow download to start
                        return new Promise(resolve => setTimeout(resolve, 500));
                    })
                    .catch(() => {})  // Ignore if not capturing
                    .then(() => {
                        return fetch('/api/shutdown', {method: 'POST'});
                    })
                    .then(r => r.json())
                    .then(data => {
                        alert(data.message);
                    })
                    .catch(() => {
                        // Connection will be lost after shutdown
                    });
            }
        }

        function dismissStickyValve() {
            fetch('/api/dismiss_sticky_valve', {method: 'POST'})
                .then(r => r.json())
                .then(data => {
                    document.getElementById('stickyValveWarning').style.display = 'none';
                });
        }

        // ATIS input handling
        function updateAtis() {
            const altimeter = document.getElementById('atisAltimeter').value.trim();
            const oat = document.getElementById('atisOat').value.trim();

            const data = {};
            if (altimeter !== '') data.altimeter = parseFloat(altimeter);
            else data.altimeter = null;
            if (oat !== '') data.oat = parseFloat(oat);
            else data.oat = null;

            fetch('/api/atis', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            }).then(r => r.json()).then(result => {
                updateAtisStyle();
            });
        }

        function clearAtis() {
            document.getElementById('atisAltimeter').value = '';
            document.getElementById('atisOat').value = '';
            fetch('/api/atis', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({altimeter: null, oat: null})
            }).then(r => r.json()).then(result => {
                updateAtisStyle();
            });
        }

        function updateAtisStyle() {
            const altEl = document.getElementById('atisAltimeter');
            const oatEl = document.getElementById('atisOat');
            altEl.classList.toggle('has-value', altEl.value.trim() !== '');
            oatEl.classList.toggle('has-value', oatEl.value.trim() !== '');
        }

        // Attach event listeners for ATIS inputs
        document.addEventListener('DOMContentLoaded', function() {
            const altEl = document.getElementById('atisAltimeter');
            const oatEl = document.getElementById('atisOat');
            altEl.addEventListener('change', updateAtis);
            oatEl.addEventListener('change', updateAtis);
            altEl.addEventListener('blur', updateAtis);
            oatEl.addEventListener('blur', updateAtis);
        });

        function downloadFile(name) {
            triggerDownload(name);
        }

        // File upload handling - wrap in DOMContentLoaded to ensure element exists
        document.addEventListener('DOMContentLoaded', function() {
            const uploadInput = document.getElementById('uploadInput');
            if (uploadInput) {
                uploadInput.addEventListener('change', function(e) {
                    const files = e.target.files;
                    const preview = document.getElementById('uploadPreview');
                    const uploadBtn = document.getElementById('uploadBtn');

                    if (files.length === 0) {
                        preview.textContent = '';
                        uploadBtn.style.display = 'none';
                        return;
                    }

                    const fileList = Array.from(files).map(f => `${f.name} (${(f.size/1024).toFixed(1)} KB)`).join(', ');
                    preview.textContent = `Selected: ${fileList}`;
                    uploadBtn.style.display = 'inline-block';
                });
            }
        });

        function uploadFiles() {
            const input = document.getElementById('uploadInput');
            const files = input.files;
            const statusEl = document.getElementById('uploadStatus');
            const uploadBtn = document.getElementById('uploadBtn');

            if (files.length === 0) {
                alert('No files selected');
                return;
            }

            statusEl.textContent = 'Uploading...';
            statusEl.style.color = '#CC6600';
            uploadBtn.disabled = true;

            const formData = new FormData();
            for (let i = 0; i < files.length; i++) {
                formData.append('file' + i, files[i]);
            }

            fetch('/api/upload', {
                method: 'POST',
                body: formData
            })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    statusEl.textContent = data.message;
                    statusEl.style.color = '#006400';
                    input.value = '';
                    document.getElementById('uploadPreview').textContent = '';
                    uploadBtn.style.display = 'none';
                    alert(data.message + '. Restart service: sudo systemctl restart engine_monitor');
                } else {
                    statusEl.textContent = 'Error: ' + data.error;
                    statusEl.style.color = '#CC0000';
                }
                uploadBtn.disabled = false;
            })
            .catch(err => {
                statusEl.textContent = 'Upload failed: ' + err;
                statusEl.style.color = '#CC0000';
                uploadBtn.disabled = false;
            });
        }

        // Cylinder colors - HIGH CONTRAST for sunlight readability on white background
        // Using dark, saturated colors that are easily distinguishable
        const cylColors = ['#CC0000', '#006400', '#00008B', '#CC6600'];  // Dark Red, Dark Green, Dark Blue, Dark Orange

        // Chart configuration with Y axis on both sides - SUNLIGHT OPTIMIZED
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: {
                    labels: {
                        color: '#000',
                        font: { size: 11, weight: 'bold' },
                        padding: 8
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#000', font: { size: 12, weight: '600' }, maxTicksLimit: 10 },
                    grid: { color: '#CCC' }
                },
                y: {
                    position: 'left',
                    ticks: { color: '#000', font: { size: 12, weight: '600' } },
                    grid: { color: '#CCC' }
                },
                y1: {
                    position: 'right',
                    ticks: { color: '#000', font: { size: 12, weight: '600' } },
                    grid: { drawOnChartArea: false }
                }
            }
        };

        // Initialize EGT Chart (deep copy options so charts don't share state)
        // Using THICK lines (borderWidth: 3) for sunlight visibility
        const egtCtx = document.getElementById('egtChart').getContext('2d');
        const egtChart = new Chart(egtCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    { label: 'EGT1', data: [], borderColor: cylColors[0], borderWidth: 3, pointRadius: 0, tension: 0.1, yAxisID: 'y' },
                    { label: 'EGT2', data: [], borderColor: cylColors[1], borderWidth: 3, pointRadius: 0, tension: 0.1, yAxisID: 'y' },
                    { label: 'EGT3', data: [], borderColor: cylColors[2], borderWidth: 3, pointRadius: 0, tension: 0.1, yAxisID: 'y' },
                    { label: 'EGT4', data: [], borderColor: cylColors[3], borderWidth: 3, pointRadius: 0, tension: 0.1, yAxisID: 'y' }
                ]
            },
            options: JSON.parse(JSON.stringify(chartOptions))
        });

        // Initialize CHT Chart (deep copy options so charts don't share state)
        // Using THICK lines (borderWidth: 3) for sunlight visibility
        const chtCtx = document.getElementById('chtChart').getContext('2d');
        const chtChart = new Chart(chtCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    { label: 'CHT1', data: [], borderColor: cylColors[0], borderWidth: 3, pointRadius: 0, tension: 0.1, yAxisID: 'y' },
                    { label: 'CHT2', data: [], borderColor: cylColors[1], borderWidth: 3, pointRadius: 0, tension: 0.1, yAxisID: 'y' },
                    { label: 'CHT3', data: [], borderColor: cylColors[2], borderWidth: 3, pointRadius: 0, tension: 0.1, yAxisID: 'y' },
                    { label: 'CHT4', data: [], borderColor: cylColors[3], borderWidth: 3, pointRadius: 0, tension: 0.1, yAxisID: 'y' }
                ]
            },
            options: JSON.parse(JSON.stringify(chartOptions))
        });

        function updateCharts() {
            if (isOffline) return;
            const duration = document.getElementById('chartDuration').value;
            fetch('/api/history?duration=' + duration)
                .then(r => r.json())
                .then(data => {
                    if (!data.labels || data.labels.length === 0) return;

                    // Update EGT chart
                    egtChart.data.labels = data.labels;
                    egtChart.data.datasets[0].data = data.egt.EGT1;
                    egtChart.data.datasets[1].data = data.egt.EGT2;
                    egtChart.data.datasets[2].data = data.egt.EGT3;
                    egtChart.data.datasets[3].data = data.egt.EGT4;
                    // First update to calculate scales
                    egtChart.update('none');
                    // Sync right Y axis with left Y axis for EGT
                    const egtYScale = egtChart.scales.y;
                    egtChart.options.scales.y1.min = egtYScale.min;
                    egtChart.options.scales.y1.max = egtYScale.max;
                    // Second update to apply synced scales
                    egtChart.update('none');

                    // Update CHT chart
                    chtChart.data.labels = data.labels;
                    chtChart.data.datasets[0].data = data.cht.CHT1;
                    chtChart.data.datasets[1].data = data.cht.CHT2;
                    chtChart.data.datasets[2].data = data.cht.CHT3;
                    chtChart.data.datasets[3].data = data.cht.CHT4;
                    // First update to calculate scales
                    chtChart.update('none');
                    // Sync right Y axis with left Y axis for CHT
                    const chtYScale = chtChart.scales.y;
                    chtChart.options.scales.y1.min = chtYScale.min;
                    chtChart.options.scales.y1.max = chtYScale.max;
                    // Second update to apply synced scales
                    chtChart.update('none');
                })
                .catch(e => console.error('Chart update error:', e));
        }

        // Fuel tracking functions
        let currentFuelRemaining = 0;
        const FUEL_CAPACITY = 36.0;  // Aircraft capacity, 2x 18 gal tanks ("usable capacity" deprecated)

        function updateFuelDisplay(fuel) {
            if (!fuel) return;

            currentFuelRemaining = fuel.fuel_remaining || 0;

            // Update fuel gauges
            document.getElementById('fuelRemaining').textContent =
                fuel.fuel_remaining !== undefined ? fuel.fuel_remaining.toFixed(1) : '--.-';
            document.getElementById('fuelUsed').textContent =
                fuel.flight_fuel_used !== undefined ? fuel.flight_fuel_used.toFixed(1) : '--.-';

            // Endurance formatting (hours to H:MM)
            if (fuel.endurance_hours !== undefined && fuel.endurance_hours > 0) {
                const hrs = Math.floor(fuel.endurance_hours);
                const mins = Math.round((fuel.endurance_hours - hrs) * 60);
                document.getElementById('fuelEndurance').textContent = hrs + ':' + mins.toString().padStart(2, '0');
            } else {
                document.getElementById('fuelEndurance').textContent = '-:--';
            }

            // Range
            document.getElementById('fuelRange').textContent =
                fuel.range_nm !== undefined ? Math.round(fuel.range_nm) : '---';

            // Fuel bar
            const pct = Math.min(100, (fuel.fuel_remaining / FUEL_CAPACITY) * 100);
            const bar = document.getElementById('fuelBar');
            bar.style.width = pct + '%';
            bar.className = 'fuel-bar';
            if (pct <= 12) bar.classList.add('critical');  // ~4 gal
            else if (pct <= 24) bar.classList.add('low');   // ~8 gal

            document.getElementById('fuelBarLabel').textContent =
                pct.toFixed(0) + '% (' + fuel.fuel_remaining.toFixed(1) + '/' + FUEL_CAPACITY + ' gal)';

            // Efficiency display
            if (fuel.cruise_efficiency) {
                const eff = fuel.cruise_efficiency;
                document.getElementById('fuelEfficiency').textContent =
                    eff.avg_fuel_flow.toFixed(1) + ' GPH @ ' +
                    Math.round(eff.avg_ground_speed) + ' kts = ' +
                    eff.nm_per_gallon.toFixed(1) + ' nm/gal';
            } else {
                document.getElementById('fuelEfficiency').textContent = '-- GPH @ -- kts = -- nm/gal';
            }

            // EDM fuel tank readings
            document.getElementById('edmFuelLeft').textContent =
                fuel.edm_fuel_left !== undefined ? fuel.edm_fuel_left.toFixed(1) : '--.-';
            document.getElementById('edmFuelRight').textContent =
                fuel.edm_fuel_right !== undefined ? fuel.edm_fuel_right.toFixed(1) : '--.-';
            document.getElementById('edmFuelTotal').textContent =
                fuel.edm_fuel_total !== undefined ? fuel.edm_fuel_total.toFixed(1) : '--.-';

            // Fuel warnings
            const warningEl = document.getElementById('fuelWarning');
            if (fuel.warnings && fuel.warnings.length > 0) {
                const warn = fuel.warnings[0];
                document.getElementById('fuelWarningText').textContent = warn.message;
                warningEl.className = 'fuel-warning' + (warn.level === 'critical' ? ' critical' : '');
                warningEl.style.display = 'flex';
            } else {
                warningEl.style.display = 'none';
            }
        }

        function dismissFuelWarning() {
            fetch('/api/fuel/dismiss_warning', {method: 'POST'})
                .then(r => r.json())
                .then(data => {
                    const el = document.getElementById('fuelWarning');
                    if (el) el.style.display = 'none';
                })
                .catch(e => console.error('Dismiss warning error:', e));
        }

        function openAddFuelModal() {
            const modal = document.getElementById('addFuelModal');
            if (!modal) return;

            const now = new Date();
            const dateEl = document.getElementById('fuelDate');
            const timeEl = document.getElementById('fuelTime');
            const airportEl = document.getElementById('fuelAirport');
            const gallonsEl = document.getElementById('fuelGallons');
            const priceEl = document.getElementById('fuelPrice');
            const notesEl = document.getElementById('fuelNotes');
            const modeEl = document.querySelector('input[name="fuelMode"][value="add"]');
            const calEl = document.getElementById('includeCalibration');

            if (dateEl) dateEl.value = now.toISOString().split('T')[0];
            if (timeEl) timeEl.value = now.toTimeString().slice(0, 5);
            if (airportEl) airportEl.value = '';
            if (gallonsEl) gallonsEl.value = '';
            if (priceEl) priceEl.value = '';
            if (notesEl) notesEl.value = '';
            if (modeEl) modeEl.checked = true;
            if (calEl) calEl.checked = true;
            updateFuelPreview();
            modal.style.display = 'flex';
        }

        function closeAddFuelModal() {
            const modal = document.getElementById('addFuelModal');
            if (modal) modal.style.display = 'none';
        }

        function updateFuelPreview() {
            const gallonsEl = document.getElementById('fuelGallons');
            const previewEl = document.getElementById('fuelPreview');
            const modeEl = document.querySelector('input[name="fuelMode"]:checked');
            if (!gallonsEl || !previewEl || !modeEl) return;

            const gallons = parseFloat(gallonsEl.value) || 0;
            const mode = modeEl.value;
            const current = currentFuelRemaining;
            let after;
            if (mode === 'set') {
                after = Math.min(gallons, FUEL_CAPACITY);
            } else {
                after = Math.min(current + gallons, FUEL_CAPACITY);
            }
            previewEl.textContent = 'Current: ' + current.toFixed(1) + ' gal → After: ' + after.toFixed(1) + ' gal';
        }

        // Add event listeners for preview updates (with null checks)
        const fuelGallonsEl = document.getElementById('fuelGallons');
        if (fuelGallonsEl) {
            fuelGallonsEl.addEventListener('input', updateFuelPreview);
        }
        document.querySelectorAll('input[name="fuelMode"]').forEach(el => {
            el.addEventListener('change', updateFuelPreview);
        });

        function submitAddFuel() {
            const gallons = parseFloat(document.getElementById('fuelGallons').value);
            if (!gallons || gallons <= 0) {
                alert('Please enter a valid gallons amount');
                return;
            }

            const data = {
                gallons: gallons,
                airport: document.getElementById('fuelAirport').value.toUpperCase(),
                price_per_gallon: parseFloat(document.getElementById('fuelPrice').value) || null,
                notes: document.getElementById('fuelNotes').value,
                set_total: document.querySelector('input[name="fuelMode"]:checked').value === 'set',
                include_in_calibration: document.getElementById('includeCalibration').checked
            };

            fetch('/api/fuel/add', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            })
            .then(r => r.json())
            .then(result => {
                if (result.success) {
                    closeAddFuelModal();
                    updateStatus();
                    alert('Fuel added: ' + result.fuel_remaining.toFixed(1) + ' gal total');
                } else {
                    alert('Error: ' + (result.error || 'Unknown error'));
                }
            })
            .catch(err => alert('Error: ' + err.message));
        }

        // Initial load and auto-refresh
        updateStatus();
        updateFiles();
        updateCharts();
        statusPollId = setInterval(updateStatus, 1000);
        filesPollId = setInterval(updateFiles, 10000);
        chartsPollId = setInterval(updateCharts, 2000);
    </script>
</body>
</html>
'''

class RequestHandler(BaseHTTPRequestHandler):
    """HTTP request handler."""

    def log_message(self, format, *args):
        """Suppress default logging."""
        pass

    def send_json(self, data, status=200):
        """Send JSON response."""
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        except BrokenPipeError:
            pass  # Client disconnected, ignore

    def send_html(self, html):
        """Send HTML response."""
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(html.encode())
        except BrokenPipeError:
            pass  # Client disconnected, ignore

    def _delayed_shutdown(self):
        """Shutdown server after a brief delay to allow response to be sent."""
        import time
        time.sleep(0.5)  # Allow response to complete
        state.stop_event.set()
        if state.capturing:
            stop_capture()
        if state.server:
            state.server.shutdown()

    def do_GET(self):
        """Handle GET requests."""
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == '/' or path == '/index.html':
            self.send_html(HTML_TEMPLATE)

        elif path == '/static/chart.min.js':
            # Serve local Chart.js file
            try:
                with open(CHART_JS_PATH, 'rb') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript')
                self.send_header('Content-Length', len(content))
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_json({'error': 'Chart.js not found'}, 404)
            except BrokenPipeError:
                pass  # Client disconnected, ignore

        elif path == '/api/status':
            self.send_json(get_status())

        elif path == '/api/files':
            self.send_json(get_files())

        elif path == '/api/diagnostics':
            self.send_json(get_diagnostics())

        elif path == '/api/history':
            # Get duration from query parameter (default 30 minutes)
            duration = 30
            if 'duration' in query:
                try:
                    duration = int(query['duration'][0])
                    duration = max(1, min(duration, 120))  # Clamp to 1-120 minutes
                except (ValueError, IndexError):
                    pass
            self.send_json(get_history(duration))

        elif path.startswith('/download/'):
            filename = path[10:]  # Remove '/download/'
            filepath = os.path.join(CONFIG['DATA_DIR'], filename)
            allowed = filename.startswith('stream_') or filename.startswith('flight_')
            if os.path.exists(filepath) and allowed:
                try:
                    content_type = 'text/csv' if filename.endswith('.csv') else 'text/plain'
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
                    self.send_header('Content-Length', os.path.getsize(filepath))
                    self.end_headers()
                    with open(filepath, 'rb') as f:
                        self.wfile.write(f.read())
                except BrokenPipeError:
                    pass  # Client disconnected, ignore
            else:
                self.send_json({'error': 'File not found'}, 404)

        elif path == '/help':
            # Serve responsive help page
            help_path = os.path.join(SCRIPT_DIR, 'HELP.html')
            try:
                with open(help_path, 'r') as f:
                    help_html = f.read()
                self.send_html(help_html)
            except FileNotFoundError:
                self.send_json({'error': 'Help file not found'}, 404)

        # PWA files for standalone fuel planner
        elif path == '/fuel-planner.html':
            pwa_path = os.path.join(SCRIPT_DIR, 'fuel-planner.html')
            try:
                with open(pwa_path, 'r') as f:
                    self.send_html(f.read())
            except FileNotFoundError:
                self.send_json({'error': 'fuel-planner.html not found'}, 404)

        elif path == '/fuel-planner.js':
            pwa_path = os.path.join(SCRIPT_DIR, 'fuel-planner.js')
            try:
                with open(pwa_path, 'rb') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript')
                self.send_header('Content-Length', len(content))
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_json({'error': 'fuel-planner.js not found'}, 404)

        elif path == '/fuel-planner.css':
            pwa_path = os.path.join(SCRIPT_DIR, 'fuel-planner.css')
            try:
                with open(pwa_path, 'rb') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/css')
                self.send_header('Content-Length', len(content))
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_json({'error': 'fuel-planner.css not found'}, 404)

        elif path == '/manifest.json' or path == '/engine-monitor-manifest.json':
            manifest_path = os.path.join(SCRIPT_DIR, os.path.basename(path))
            try:
                with open(manifest_path, 'rb') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', len(content))
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_json({'error': os.path.basename(path) + ' not found'}, 404)

        elif path == '/service-worker.js':
            sw_path = os.path.join(SCRIPT_DIR, 'service-worker.js')
            try:
                with open(sw_path, 'rb') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript')
                self.send_header('Content-Length', len(content))
                # Safari needs no-cache so it always checks for SW updates
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Service-Worker-Allowed', '/')
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_json({'error': 'service-worker.js not found'}, 404)

        # Fuel tracking API endpoints
        elif path == '/api/fuel':
            if state.fuel_tracker:
                self.send_json(state.fuel_tracker.get_status())
            else:
                self.send_json({'error': 'Fuel tracker not initialized'}, 500)

        elif path == '/api/fuel/history':
            if state.fuel_tracker:
                self.send_json({
                    'fuel_additions': state.fuel_tracker.fuel_additions[-50:],
                    'flight_history': state.fuel_tracker.flight_history[-20:]
                })
            else:
                self.send_json({'error': 'Fuel tracker not initialized'}, 500)

        elif path == '/api/fuel/calibration':
            if state.fuel_tracker:
                self.send_json(state.fuel_tracker.calibration.get_calibration_status())
            else:
                self.send_json({'error': 'Fuel tracker not initialized'}, 500)

        else:
            self.send_json({'error': 'Not found'}, 404)

    def do_POST(self):
        """Handle POST requests."""
        path = urlparse(self.path).path

        if path == '/api/start':
            result = start_capture()
            self.send_json(result)

        elif path == '/api/stop':
            result = stop_capture()
            self.send_json(result)

        elif path == '/api/shutdown':
            log("Shutdown requested via web interface")
            self.send_json({'success': True, 'message': 'Shutting down...'})
            # Trigger shutdown after response is sent
            state.shutdown_requested = True
            if state.server:
                import threading
                threading.Thread(target=self._delayed_shutdown).start()

        elif path == '/api/dismiss_sticky_valve':
            state.sticky_valve_dismissed = True
            self.send_json({'success': True, 'message': 'Alert dismissed'})

        elif path == '/api/atis':
            # Set manual ATIS values (altimeter and OAT)
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body) if body else {}

                # Altimeter setting (None to clear)
                if 'altimeter' in data:
                    alt_val = data['altimeter']
                    if alt_val is None or alt_val == '':
                        state.manual_altimeter = None
                        log("ATIS: Altimeter cleared (using default)")
                    else:
                        state.manual_altimeter = float(alt_val)
                        log(f"ATIS: Altimeter set to {state.manual_altimeter} inHg")

                # OAT (None to clear)
                if 'oat' in data:
                    oat_val = data['oat']
                    if oat_val is None or oat_val == '':
                        state.manual_oat = None
                        log("ATIS: OAT cleared (using calculated)")
                    else:
                        state.manual_oat = float(oat_val)
                        log(f"ATIS: OAT set to {state.manual_oat}°C")

                self.send_json({
                    'success': True,
                    'altimeter': state.manual_altimeter,
                    'oat': state.manual_oat
                })
            except (ValueError, json.JSONDecodeError) as e:
                self.send_json({'error': str(e)}, 400)

        # Fuel tracking POST endpoints
        elif path == '/api/fuel/set':
            if not state.fuel_tracker:
                self.send_json({'error': 'Fuel tracker not initialized'}, 500)
                return
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body) if body else {}
                fuel_remaining = float(data.get('fuel_remaining', 0))
                reason = data.get('reason', 'Manual set via API')
                state.fuel_tracker.set_fuel(fuel_remaining, reason)
                self.send_json({'success': True, 'fuel_remaining': state.fuel_tracker.fuel_remaining})
            except (ValueError, json.JSONDecodeError) as e:
                self.send_json({'error': str(e)}, 400)

        elif path == '/api/fuel/add':
            if not state.fuel_tracker:
                self.send_json({'error': 'Fuel tracker not initialized'}, 500)
                return
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body) if body else {}
                gallons = float(data.get('gallons', 0))
                airport = data.get('airport', '')
                price_per_gallon = float(data['price_per_gallon']) if data.get('price_per_gallon') else None
                notes = data.get('notes', '')
                set_total = data.get('set_total', False)
                include_in_calibration = data.get('include_in_calibration', True)

                addition = state.fuel_tracker.add_fuel(
                    gallons=gallons,
                    airport=airport,
                    price_per_gallon=price_per_gallon,
                    notes=notes,
                    set_total=set_total,
                    include_in_calibration=include_in_calibration
                )
                self.send_json({'success': True, 'addition': addition, 'fuel_remaining': state.fuel_tracker.fuel_remaining})
            except (ValueError, json.JSONDecodeError) as e:
                self.send_json({'error': str(e)}, 400)

        elif path == '/api/fuel/dismiss_warning':
            if state.fuel_tracker:
                state.fuel_tracker.dismiss_warning()
                self.send_json({'success': True, 'message': 'Fuel warning dismissed'})
            else:
                self.send_json({'error': 'Fuel tracker not initialized'}, 500)

        elif path == '/api/fuel/calibration/reset':
            if state.fuel_tracker:
                state.fuel_tracker.calibration.start_period()
                state.fuel_tracker._save_state()
                self.send_json({'success': True, 'message': 'Calibration period reset'})
            else:
                self.send_json({'error': 'Fuel tracker not initialized'}, 500)

        elif path == '/api/fuel/calibration/applied':
            if not state.fuel_tracker:
                self.send_json({'error': 'Fuel tracker not initialized'}, 500)
                return
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body) if body else {}
                new_k_factor = int(data.get('new_k_factor', 0))
                if new_k_factor <= 0:
                    self.send_json({'error': 'Invalid K-factor'}, 400)
                    return
                state.fuel_tracker.calibration.apply_k_factor(new_k_factor)
                state.fuel_tracker._save_state()
                self.send_json({'success': True, 'message': f'K-factor {new_k_factor} recorded as applied'})
            except (ValueError, json.JSONDecodeError) as e:
                self.send_json({'error': str(e)}, 400)

        elif path == '/api/upload':
            # File upload endpoint for updating scripts from iPad.
            try:
                supplied = self.headers.get('X-Upload-Token', '')
                if not UPLOAD_TOKEN or not hmac.compare_digest(supplied, UPLOAD_TOKEN):
                    log("Upload rejected: missing/invalid X-Upload-Token")
                    self.send_json({'error': 'Unauthorized'}, 401)
                    return

                content_type = self.headers.get('Content-Type', '')
                if 'multipart/form-data' not in content_type:
                    self.send_json({'error': 'Expected multipart/form-data'}, 400)
                    return

                content_length = int(self.headers.get('Content-Length', 0))
                if content_length <= 0:
                    self.send_json({'error': 'Missing or empty Content-Length'}, 400)
                    return
                if content_length > MAX_UPLOAD_BYTES:
                    log(f"Upload rejected: Content-Length {content_length} exceeds {MAX_UPLOAD_BYTES}-byte cap")
                    self.send_json({'error': f'Upload too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)'}, 413)
                    return

                # Parse multipart form data
                body = self.rfile.read(content_length)

                # Extract boundary from content-type
                boundary = None
                for part in content_type.split(';'):
                    part = part.strip()
                    if part.startswith('boundary='):
                        boundary = part[9:].strip('"')
                        break

                if not boundary:
                    self.send_json({'error': 'No boundary found in content-type'}, 400)
                    return

                # Parse the multipart data
                boundary_bytes = ('--' + boundary).encode()
                parts = body.split(boundary_bytes)

                uploaded_files = []
                allowed_extensions = {'.py', '.js', '.html', '.css', '.json', '.md'}

                for part in parts:
                    if b'Content-Disposition' not in part:
                        continue

                    # Extract filename
                    header_end = part.find(b'\r\n\r\n')
                    if header_end == -1:
                        continue

                    header = part[:header_end].decode('utf-8', errors='ignore')
                    file_content = part[header_end + 4:].rstrip(b'\r\n--')

                    # Parse filename from header
                    filename = None
                    for line in header.split('\r\n'):
                        if 'filename=' in line:
                            start = line.find('filename="') + 10
                            end = line.find('"', start)
                            if start > 9 and end > start:
                                filename = line[start:end]
                                break

                    if not filename or not file_content:
                        continue

                    # Security: only allow specific extensions
                    _, ext = os.path.splitext(filename)
                    if ext.lower() not in allowed_extensions:
                        log(f"Upload rejected: {filename} (extension {ext} not allowed)")
                        continue

                    # Security: prevent path traversal
                    safe_filename = os.path.basename(filename)

                    # Write to script directory
                    filepath = os.path.join(SCRIPT_DIR, safe_filename)
                    with open(filepath, 'wb') as f:
                        f.write(file_content)

                    file_size = len(file_content)
                    uploaded_files.append({'name': safe_filename, 'size': file_size})
                    log(f"File uploaded: {safe_filename} ({file_size} bytes)")

                if uploaded_files:
                    self.send_json({
                        'success': True,
                        'message': f'Uploaded {len(uploaded_files)} file(s)',
                        'files': uploaded_files
                    })
                else:
                    self.send_json({'error': 'No valid files in upload'}, 400)

            except Exception as e:
                log(f"Upload error: {e}")
                self.send_json({'error': str(e)}, 500)

        else:
            self.send_json({'error': 'Not found'}, 404)

def main():
    """Main entry point."""
    import argparse
    parser = argparse.ArgumentParser(
        description='Engine Monitor Web Server',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  Live mode (aircraft):
    python3 engine_monitor.py

  Playback mode (desktop):
    python3 engine_monitor.py --playback stream_2025-01-10_14-30-00.txt
    python3 engine_monitor.py --playback stream.txt --kml tracklog.kml
    python3 engine_monitor.py --playback stream.txt --kml track.kml --playback-rate 10
        """
    )
    parser.add_argument('--port', type=str, help='Serial port (default: /dev/ttyUSB0)')
    parser.add_argument('--web-port', type=int, help='Web server port (default: 8080)')
    parser.add_argument('--bind', type=str, help='IP to bind to (auto-detected based on hostname)')
    parser.add_argument('--no-stratux', action='store_true',
                        help='Disable Stratux HTTP polling (use if ForeFlight needs priority)')
    # Playback mode arguments
    parser.add_argument('--playback', type=str, metavar='FILE',
                        help='Playback mode: path to captured stream file')
    parser.add_argument('--kml', type=str, metavar='FILE',
                        help='KML file for GPS data during playback')
    parser.add_argument('--playback-rate', type=float, default=1.0,
                        help='Playback speed multiplier (default: 1.0, use 10 for fast-forward)')
    args = parser.parse_args()

    # Configure playback mode
    playback_mode = args.playback is not None
    if playback_mode:
        CONFIG['PLAYBACK_MODE'] = True
        CONFIG['PLAYBACK_FILE'] = args.playback
        CONFIG['PLAYBACK_RATE'] = args.playback_rate
        if args.kml:
            CONFIG['KML_FILE'] = args.kml

    # Override config from command line
    if args.port:
        CONFIG['SERIAL_PORT'] = args.port
    if args.web_port:
        CONFIG['WEB_PORT'] = args.web_port

    # Use auto-detected bind address or command-line override
    bind_address = args.bind if args.bind else CONFIG['WEB_BIND']
    stratux_enabled = not args.no_stratux

    # Ensure data directory exists
    os.makedirs(CONFIG['DATA_DIR'], exist_ok=True)

    log("=" * 50)
    log("Engine Monitor starting")
    log(f"Version: {VERSION}")
    log(f"Environment: {'AIRCRAFT' if CONFIG['IS_AIRCRAFT'] else 'DESKTOP'} (hostname: {CONFIG['HOSTNAME']})")
    if playback_mode:
        log(f"Mode: PLAYBACK at {args.playback_rate}x speed")
        log(f"Playback file: {args.playback}")
        if args.kml:
            log(f"KML GPS file: {args.kml}")
    else:
        log(f"Mode: LIVE")
        log(f"Serial port: {CONFIG['SERIAL_PORT']}")
    log(f"Data directory: {CONFIG['DATA_DIR']}")
    log(f"Web interface: http://{bind_address}:{CONFIG['WEB_PORT']}")
    log("=" * 50)

    # Check for pyserial (only needed in live mode)
    if not playback_mode:
        try:
            import serial
            log("pyserial module found")
        except ImportError:
            log("ERROR: pyserial not installed. Run: pip3 install pyserial")
            sys.exit(1)

    # Initialize fuel tracker
    state.fuel_tracker = FuelTracker(CONFIG['DATA_DIR'])
    log(f"Fuel tracker initialized - {state.fuel_tracker.fuel_remaining:.1f} gal remaining")

    # Start Stratux/KML GPS thread (unless disabled)
    if not stratux_enabled and not CONFIG.get('KML_FILE'):
        log("Stratux/GPS integration DISABLED (--no-stratux flag)")
    elif CONFIG.get('KML_FILE'):
        log(f"GPS integration via KML file: {CONFIG['KML_FILE']}")
        state.stratux_thread = threading.Thread(target=stratux_thread_func, daemon=True)
        state.stratux_thread.start()
    else:
        log(f"Stratux integration via HTTP API: {CONFIG['STRATUX_HTTP_URL']}")
        log("(Uses HTTP polling - won't interfere with ForeFlight's GDL90 connection)")
        state.stratux_thread = threading.Thread(target=stratux_thread_func, daemon=True)
        state.stratux_thread.start()

    # In playback mode, auto-start capture
    if playback_mode:
        log("Auto-starting playback...")
        start_capture()

    # Auto-recovery: monitor serial port and auto-start capture when EDM data detected.
    # This handles crash-restart: systemd restarts the process, this thread detects
    # the EDM is still streaming, and restarts capture automatically.
    if not playback_mode:
        def auto_capture_monitor():
            """Background thread: auto-start capture when serial port has EDM data."""
            import serial as _serial
            port = CONFIG['SERIAL_PORT']
            log("Auto-capture monitor started")
            while not state.stop_event.is_set():
                # Only act if not already capturing
                if state.capturing:
                    state.stop_event.wait(5)
                    continue

                # Check if serial port exists
                if not os.path.exists(port):
                    state.stop_event.wait(10)
                    continue

                # Probe the port briefly for EDM data
                try:
                    probe = _serial.Serial(port, CONFIG['BAUD_RATE'], timeout=3,
                                           bytesize=_serial.EIGHTBITS, parity=_serial.PARITY_NONE,
                                           stopbits=_serial.STOPBITS_ONE)
                    data = probe.read(256)
                    probe.close()

                    if data and len(data) > 10:
                        log(f"Auto-capture: EDM data detected on {port} ({len(data)} bytes), starting capture")
                        time.sleep(0.5)  # Let port fully release before capture thread opens it
                        if not state.capturing:
                            start_capture()
                except Exception as e:
                    # Port busy or unavailable — try again later
                    pass

                state.stop_event.wait(15)
            log("Auto-capture monitor stopped")

        acm_thread = threading.Thread(target=auto_capture_monitor, daemon=True)
        acm_thread.start()

    # Start WebSocket server for real-time engine data push (FlyTab)
    def start_ws_server():
        try:
            import asyncio
            import websockets
        except ImportError:
            log("websockets library not installed — WS endpoint disabled (pip install websockets)")
            return

        ws_clients = set()

        async def ws_handler(websocket):
            """Handle /ws/engine connections — push engine status at 1Hz"""
            ws_clients.add(websocket)
            log(f"WS client connected ({len(ws_clients)} total)")
            try:
                async for _ in websocket:
                    pass  # We only push, never read
            except websockets.exceptions.ConnectionClosed:
                pass
            finally:
                ws_clients.discard(websocket)
                log(f"WS client disconnected ({len(ws_clients)} total)")

        async def broadcast_loop():
            """Push engine status to all connected WS clients at 1Hz"""
            while not state.stop_event.is_set():
                if ws_clients:
                    try:
                        status = get_status()
                        msg = json.dumps(status)
                        dead = set()
                        for ws in ws_clients.copy():
                            try:
                                await ws.send(msg)
                            except Exception:
                                dead.add(ws)
                        for d in dead:
                            ws_clients.discard(d)
                    except Exception as e:
                        log(f"WS broadcast error: {e}")
                await asyncio.sleep(1.0)

        async def ws_main():
            ws_port = CONFIG['WEB_PORT'] + 2  # 8082 (8080 HTTP + 2)
            ws_server = await websockets.serve(
                ws_handler, bind_address, ws_port,
                ping_interval=20, ping_timeout=10
            )
            log(f"WebSocket server running on port {ws_port} (/ws/engine)")
            await broadcast_loop()
            ws_server.close()
            await ws_server.wait_closed()

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(ws_main())
        except Exception as e:
            log(f"WS server error: {e}")

    ws_thread = threading.Thread(target=start_ws_server, daemon=True)
    ws_thread.start()

    # Start web server
    server = ThreadingHTTPServer((bind_address, CONFIG['WEB_PORT']), RequestHandler)
    state.server = server  # Store reference for shutdown via web interface

    def signal_handler(sig, frame):
        log("Shutdown signal received")
        state.stop_event.set()  # Signal all threads to stop
        if state.capturing:
            stop_capture()
        # Run shutdown in separate thread to avoid deadlock with serve_forever
        threading.Thread(target=server.shutdown).start()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    log(f"Server running on port {CONFIG['WEB_PORT']}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        state.stop_event.set()  # Signal all threads to stop
        if state.capturing:
            stop_capture()
        log("Server stopped")

if __name__ == '__main__':
    main()
