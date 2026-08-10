#!/usr/bin/env python3
"""
Engine Monitor Web Server
=========================
All-in-one solution for capturing, monitoring, and downloading engine data.
Designed for high-visibility on a cockpit tablet in direct sunlight.

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
PI_CAPABILITIES = ["fuel_tracker", "peak_egt"]

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
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
import glob
import uuid
import shutil
import hmac
import secrets

# Path to local Chart.js file (same directory as this script)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Stratux integration uses HTTP API (no extra dependencies needed)

# Constants for calculations
HISTORY_SECONDS = 30 * 60  # 30 minutes of history

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

# Auto-detect environment (stratux hostname = aircraft, otherwise desktop).
# 'flypi' here is the real OS hostname of a Pi, a leftover from the deprecated
# FlyPi/iPad predecessor product (see CLAUDE.md) — NOT evidence that FlyPi or
# an iPad still exists. Do not remove this string without first confirming
# (on the actual device) that the Pi's hostname has actually been changed —
# removing it while a real Pi is still named 'flypi' would silently flip
# production mode off (wrong DATA_DIR, wrong bind behavior).
_hostname = socket.gethostname()
_is_aircraft = _hostname in ('stratux', 'flypi')

# Configuration
CONFIG = {
    'SERIAL_PORT': '/dev/ttyUSB0',
    'BAUD_RATE': 115200,
    'DATA_DIR': '/opt/capture_v5' if _is_aircraft else os.path.expanduser('~/engine_data'),
    'WEB_PORT': 8080,
    'WEB_BIND': '0.0.0.0',  # Bind all interfaces — must be reachable from the tablet over the aircraft WiFi, not just localhost
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
        self.manually_stopped = False  # True after an explicit /api/stop; blocks
                                        # auto_capture_monitor's auto-restart until
                                        # cleared by Start or engine RPM < 300.
        self.capture_thread = None
        self.stop_event = threading.Event()
        self.latest_data = {}
        self.data_count = 0
        self.capture_start_time = None
        self.last_error = None
        self.serial_connected = False
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

    state.manually_stopped = False

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
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'Engine Monitor API running -- see FlyTab\n')
            except BrokenPipeError:
                pass  # Client disconnected, ignore

        elif path == '/api/status':
            self.send_json(get_status())

        elif path == '/api/files':
            self.send_json(get_files())

        elif path == '/api/diagnostics':
            self.send_json(get_diagnostics())

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
                # No-cache so the browser always checks for service worker updates
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
            state.manually_stopped = True
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
            # File upload endpoint for pushing updated script files to the Pi.
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
                        # If a manual Stop is latched, use this same probe data to
                        # check whether the engine has since shut down — if RPM has
                        # dropped below 300, clear the latch so the *next* flight's
                        # auto-capture still works. Independent of check_sticky_valve()
                        # (deleted in Task 2) — this is its own inline check against
                        # the most recent parseable line in the probe.
                        if state.manually_stopped:
                            last_rpm = None
                            for line in data.decode('utf-8', errors='ignore').split('\n'):
                                parsed = parse_line(line)
                                if parsed:
                                    last_rpm = parsed.get('RPM', 0)
                            if last_rpm is not None and last_rpm < 300:
                                state.manually_stopped = False
                                log("Auto-capture: engine RPM dropped below 300, manual-stop latch cleared")

                        if not state.manually_stopped:
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
