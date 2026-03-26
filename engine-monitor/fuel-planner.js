/**
 * Fuel Planner PWA Application
 * Standalone offline fuel planning with Stratux sync
 */

class FuelPlannerApp {
    constructor() {
        // Use current host - works on Stratux (192.168.10.1) or desktop testing
        this.stratuxUrl = window.location.origin;
        this.syncInterval = null;
        this.data = this.loadLocal();
        this.isOnline = false;

        // Burn rate profiles
        this.profiles = {
            'cruise_65_lop': { name: '65% Cruise LOP', gph: 8.0, ktas: 135 },
            'cruise_75': { name: '75% Cruise', gph: 9.5, ktas: 145 },
            'cruise_65_rop': { name: '65% Cruise ROP', gph: 9.8, ktas: 140 },
            'pattern': { name: 'Pattern Work', gph: 10.0, ktas: 90 },
            'custom': { name: 'Custom', gph: 8.5, ktas: 130 }
        };

        this.FUEL_CAPACITY = 34.0;  // Usable capacity
        this.reserveOptions = [30, 45, 60];  // minutes

        // Tic mark to gallons polynomial coefficients (5th degree)
        // From fuel_tracking_app calibration
        this.ticCoefficients = {
            a5: 0.00073877,
            a4: -0.021782,
            a3: 0.22914,
            a2: -1.0819,
            a1: 3.7826,
            a0: 2.2368
        };
    }

    loadLocal() {
        const stored = localStorage.getItem('fuelPlannerData');
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch (e) {
                console.error('Error loading stored data:', e);
            }
        }
        return {
            fuel_remaining: 0,
            last_updated: null,
            update_source: 'manual',
            pending_additions: [],
            custom_gph: 8.5
        };
    }

    saveLocal() {
        localStorage.setItem('fuelPlannerData', JSON.stringify(this.data));
    }

    async sync() {
        this.updateSyncStatus('syncing');

        try {
            // Try to reach Stratux
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);

            const response = await fetch(`${this.stratuxUrl}/api/fuel`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            const serverData = await response.json();

            // Compare timestamps
            const serverTime = serverData.last_updated ? new Date(serverData.last_updated).getTime() : 0;
            const localTime = this.data.last_updated ? new Date(this.data.last_updated).getTime() : 0;

            if (serverTime > localTime) {
                // Server is newer - pull
                this.data.fuel_remaining = serverData.fuel_remaining;
                this.data.last_updated = serverData.last_updated;
                this.data.update_source = 'stratux_sync';
                this.saveLocal();
                this.updateUI();
            }

            // Push pending additions
            if (this.data.pending_additions.length > 0) {
                for (const addition of this.data.pending_additions) {
                    await fetch(`${this.stratuxUrl}/api/fuel/add`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(addition)
                    });
                }
                this.data.pending_additions = [];
                this.saveLocal();
            }

            this.isOnline = true;
            this.updateSyncStatus('connected');

            // Check for pending measurement comparison
            const comparison = this.updatePendingMeasurementComparison();
            if (comparison) {
                updateFuelCheckUI();
            }

            return { status: 'synced', message: 'In sync with Stratux' };

        } catch (error) {
            this.isOnline = false;
            this.updateSyncStatus('offline');
            return { status: 'offline', message: 'Working offline' };
        }
    }

    updateSyncStatus(status) {
        const el = document.getElementById('syncStatus');
        if (!el) return;

        el.className = 'sync-status';
        switch (status) {
            case 'connected':
                el.textContent = 'Connected';
                el.classList.add('connected');
                break;
            case 'syncing':
                el.textContent = 'Syncing...';
                el.classList.add('syncing');
                break;
            default:
                el.textContent = 'Offline';
                break;
        }
    }

    calculate(fuelRemaining, profileId, reserveMinutes) {
        const profile = this.profiles[profileId];
        if (!profile) return null;

        // Use custom GPH if custom profile
        const gph = profileId === 'custom' ? this.data.custom_gph : profile.gph;
        const ktas = profile.ktas;

        const reserveGal = (reserveMinutes / 60) * gph;
        const usableFuel = Math.max(0, fuelRemaining - reserveGal);
        const flightHours = usableFuel / gph;
        const rangeNm = flightHours * ktas;

        return {
            usable_fuel: Math.round(usableFuel * 10) / 10,
            reserve_gal: Math.round(reserveGal * 10) / 10,
            flight_hours: Math.round(flightHours * 100) / 100,
            flight_time_display: this.formatTime(flightHours * 60),
            range_nm: Math.round(rangeNm),
            profile_name: profile.name,
            gph: gph,
            ktas: ktas
        };
    }

    fuelNeeded(flightHours, profileId, reserveMinutes) {
        const profile = this.profiles[profileId];
        if (!profile) return 0;

        const gph = profileId === 'custom' ? this.data.custom_gph : profile.gph;
        const reserveGal = (reserveMinutes / 60) * gph;
        const flightFuel = flightHours * gph;
        return Math.round((flightFuel + reserveGal) * 10) / 10;
    }

    formatTime(totalMinutes) {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = Math.round(totalMinutes % 60);
        return `${hours} hr ${minutes} min`;
    }

    // Convert tic mark reading to gallons using 5th degree polynomial
    ticToGallons(tic) {
        const c = this.ticCoefficients;
        return c.a5 * Math.pow(tic, 5) +
               c.a4 * Math.pow(tic, 4) +
               c.a3 * Math.pow(tic, 3) +
               c.a2 * Math.pow(tic, 2) +
               c.a1 * tic +
               c.a0;
    }

    // Save a fuel measurement to history
    saveMeasurement(leftTic, rightTic, notes = '') {
        const leftGal = this.ticToGallons(leftTic);
        const rightGal = this.ticToGallons(rightTic);
        const totalMeasured = leftGal + rightGal;

        const measurement = {
            id: this.generateUUID(),
            timestamp: new Date().toISOString(),
            leftTic: leftTic,
            rightTic: rightTic,
            leftGallons: Math.round(leftGal * 100) / 100,
            rightGallons: Math.round(rightGal * 100) / 100,
            totalMeasured: Math.round(totalMeasured * 100) / 100,
            edmReading: this.isOnline ? this.data.fuel_remaining : null,
            variance: this.isOnline ? Math.round((totalMeasured - this.data.fuel_remaining) * 100) / 100 : null,
            variancePercent: this.isOnline && this.data.fuel_remaining > 0
                ? Math.round(((totalMeasured - this.data.fuel_remaining) / this.data.fuel_remaining) * 10000) / 100
                : null,
            notes: notes,
            comparedToEdm: this.isOnline
        };

        // Initialize measurements array if needed
        if (!this.data.measurements) {
            this.data.measurements = [];
        }

        this.data.measurements.push(measurement);

        // Keep last 100 measurements
        if (this.data.measurements.length > 100) {
            this.data.measurements = this.data.measurements.slice(-100);
        }

        // Store as pending if offline (for later comparison)
        if (!this.isOnline) {
            if (!this.data.pendingMeasurement) {
                this.data.pendingMeasurement = measurement;
            }
        }

        this.saveLocal();
        return measurement;
    }

    // Get measurement history
    getMeasurementHistory() {
        return this.data.measurements || [];
    }

    // Get pending measurement (for comparison when connected)
    getPendingMeasurement() {
        return this.data.pendingMeasurement || null;
    }

    // Clear pending measurement after comparison
    clearPendingMeasurement() {
        this.data.pendingMeasurement = null;
        this.saveLocal();
    }

    // Compare measurement to EDM reading
    compareToEdm(measurement) {
        if (!measurement || !this.isOnline) return null;

        const edmReading = this.data.fuel_remaining;
        const variance = measurement.totalMeasured - edmReading;
        const variancePercent = edmReading > 0
            ? (variance / edmReading) * 100
            : 0;

        return {
            edmReading: edmReading,
            measured: measurement.totalMeasured,
            variance: Math.round(variance * 100) / 100,
            variancePercent: Math.round(variancePercent * 100) / 100,
            grade: this.getAccuracyGrade(variancePercent)
        };
    }

    // Get accuracy grade based on variance percentage
    getAccuracyGrade(variancePercent) {
        const absVar = Math.abs(variancePercent);
        if (absVar < 5) {
            return { grade: 'excellent', color: '#006400', bgColor: '#90EE90', text: 'Excellent' };
        } else if (absVar < 10) {
            return { grade: 'good', color: '#CC6600', bgColor: '#FFD700', text: 'Good' };
        } else {
            return { grade: 'check', color: '#CC0000', bgColor: '#FFB6C1', text: 'Check' };
        }
    }

    // Export measurements to CSV for Google Sheets
    exportToCSV() {
        const measurements = this.getMeasurementHistory();
        if (measurements.length === 0) {
            alert('No measurements to export');
            return;
        }

        // CSV headers
        const headers = [
            'Date',
            'Time',
            'Left Tic',
            'Right Tic',
            'Left Gal',
            'Right Gal',
            'Total Measured',
            'EDM Reading',
            'Variance (gal)',
            'Variance (%)',
            'Notes'
        ];

        // Build CSV rows
        const rows = measurements.map(m => {
            const dt = new Date(m.timestamp);
            return [
                dt.toLocaleDateString(),
                dt.toLocaleTimeString(),
                m.leftTic,
                m.rightTic,
                m.leftGallons,
                m.rightGallons,
                m.totalMeasured,
                m.edmReading !== null ? m.edmReading : '',
                m.variance !== null ? m.variance : '',
                m.variancePercent !== null ? m.variancePercent : '',
                m.notes || ''
            ].map(v => `"${v}"`).join(',');
        });

        // Create CSV content
        const csv = [headers.join(','), ...rows].join('\n');

        // Trigger download
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fuel_measurements_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Update pending measurement with EDM comparison when connected
    updatePendingMeasurementComparison() {
        const pending = this.getPendingMeasurement();
        if (pending && this.isOnline && !pending.comparedToEdm) {
            const comparison = this.compareToEdm(pending);
            if (comparison) {
                pending.edmReading = comparison.edmReading;
                pending.variance = comparison.variance;
                pending.variancePercent = comparison.variancePercent;
                pending.comparedToEdm = true;

                // Also update the measurement in history
                const historyIndex = this.data.measurements.findIndex(m => m.id === pending.id);
                if (historyIndex >= 0) {
                    this.data.measurements[historyIndex] = pending;
                }

                this.saveLocal();
                return comparison;
            }
        }
        return null;
    }

    setFuel(gallons) {
        this.data.fuel_remaining = Math.max(0, Math.min(gallons, this.FUEL_CAPACITY));
        this.data.last_updated = new Date().toISOString();
        this.data.update_source = 'manual';
        this.saveLocal();
        this.updateUI();
        this.sync();  // Try to sync if connected
    }

    adjustFuel(delta) {
        const newValue = Math.max(0, Math.min(this.data.fuel_remaining + delta, this.FUEL_CAPACITY));
        this.setFuel(newValue);
    }

    addFuelOffline(gallons, airport, setTotal, includeCalibration) {
        const addition = {
            id: this.generateUUID(),
            date: new Date().toISOString().split('T')[0],
            time: new Date().toTimeString().slice(0, 5),
            airport: airport || '',
            gallons: gallons,
            set_total: setTotal,
            include_in_calibration: includeCalibration,
            synced: false
        };

        if (setTotal) {
            this.data.fuel_remaining = Math.min(gallons, this.FUEL_CAPACITY);
        } else {
            this.data.fuel_remaining = Math.min(this.data.fuel_remaining + gallons, this.FUEL_CAPACITY);
        }

        this.data.last_updated = new Date().toISOString();
        this.data.update_source = 'manual';
        this.data.pending_additions.push(addition);
        this.saveLocal();
        this.updateUI();
        this.sync();  // Try to sync if connected
    }

    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    updateUI() {
        // Update main fuel display
        const fuelValue = document.getElementById('fuelValue');
        if (fuelValue) {
            fuelValue.textContent = this.data.fuel_remaining.toFixed(1);
        }

        // Update fuel bar
        const pct = (this.data.fuel_remaining / this.FUEL_CAPACITY) * 100;
        const fuelBar = document.getElementById('fuelBarFill');
        if (fuelBar) {
            fuelBar.style.width = `${pct}%`;
            fuelBar.className = 'fuel-bar-fill';
            if (pct <= 12) fuelBar.classList.add('critical');
            else if (pct <= 24) fuelBar.classList.add('low');
        }

        const fuelBarText = document.getElementById('fuelBarText');
        if (fuelBarText) {
            fuelBarText.textContent = `${pct.toFixed(0)}% (${this.data.fuel_remaining.toFixed(1)}/${this.FUEL_CAPACITY} gal)`;
        }

        // Update last updated
        const lastUpdated = document.getElementById('lastUpdated');
        if (lastUpdated && this.data.last_updated) {
            const date = new Date(this.data.last_updated);
            const source = this.data.update_source === 'stratux_sync' ? 'Stratux' : 'manual';
            lastUpdated.textContent = `Last updated: ${date.toLocaleString()} (${source})`;
        }

        // Update pending badge
        const pendingBadge = document.getElementById('pendingBadge');
        if (pendingBadge) {
            if (this.data.pending_additions.length > 0) {
                pendingBadge.textContent = `${this.data.pending_additions.length} pending`;
                pendingBadge.style.display = 'inline';
            } else {
                pendingBadge.style.display = 'none';
            }
        }

        // Update calculator results
        this.updateCalculation();
    }

    updateCalculation() {
        const profileSelect = document.getElementById('profileSelect');
        const reserveSelect = document.getElementById('reserveSelect');
        const customGph = document.getElementById('customGph');

        if (!profileSelect || !reserveSelect) return;

        const profileId = profileSelect.value;
        const reserveMinutes = parseInt(reserveSelect.value);

        // Show/hide custom GPH input
        const customRow = document.getElementById('customGphRow');
        if (customRow) {
            customRow.style.display = profileId === 'custom' ? 'block' : 'none';
        }

        // Update custom GPH if changed
        if (customGph && profileId === 'custom') {
            this.data.custom_gph = parseFloat(customGph.value) || 8.5;
            this.saveLocal();
        }

        const result = this.calculate(this.data.fuel_remaining, profileId, reserveMinutes);
        if (!result) return;

        // Update result display
        document.getElementById('resultUsable').textContent = `${result.usable_fuel} gal`;
        document.getElementById('resultReserve').textContent = `${result.reserve_gal} gal`;
        document.getElementById('resultTime').textContent = result.flight_time_display;
        document.getElementById('resultRange').textContent = `${result.range_nm} nm`;
        document.getElementById('resultGph').textContent = `${result.gph} GPH`;
    }

    startAutoSync() {
        // Try to sync every 30 seconds when online
        this.syncInterval = setInterval(() => this.sync(), 30000);
        // Initial sync
        this.sync();
    }

    init() {
        this.updateUI();
        this.startAutoSync();

        // Initialize fuel check UI
        setTimeout(() => updateFuelCheckUI(), 100);

        // Register service worker for offline support
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./service-worker.js')
                .then(reg => console.log('Service worker registered'))
                .catch(err => console.log('Service worker registration failed:', err));
        }
    }
}

// Initialize app when DOM is ready
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new FuelPlannerApp();
    app.init();
});

// Global functions for UI events
function syncNow() {
    app.sync();
}

function adjustFuel(delta) {
    app.adjustFuel(delta);
}

function openSetFuelModal() {
    document.getElementById('setFuelInput').value = app.data.fuel_remaining.toFixed(1);
    document.getElementById('setFuelModal').style.display = 'flex';
}

function closeSetFuelModal() {
    document.getElementById('setFuelModal').style.display = 'none';
}

function submitSetFuel() {
    const value = parseFloat(document.getElementById('setFuelInput').value);
    if (!isNaN(value) && value >= 0) {
        app.setFuel(value);
        closeSetFuelModal();
    }
}

function openAddFuelModal() {
    const now = new Date();
    document.getElementById('addFuelDate').value = now.toISOString().split('T')[0];
    document.getElementById('addFuelAirport').value = '';
    document.getElementById('addFuelGallons').value = '';
    document.querySelector('input[name="addFuelMode"][value="add"]').checked = true;
    document.getElementById('addFuelCalibration').checked = true;
    updateAddFuelPreview();
    document.getElementById('addFuelModal').style.display = 'flex';
}

function closeAddFuelModal() {
    document.getElementById('addFuelModal').style.display = 'none';
}

function updateAddFuelPreview() {
    const gallons = parseFloat(document.getElementById('addFuelGallons').value) || 0;
    const mode = document.querySelector('input[name="addFuelMode"]:checked').value;
    const current = app.data.fuel_remaining;
    let after;
    if (mode === 'set') {
        after = Math.min(gallons, app.FUEL_CAPACITY);
    } else {
        after = Math.min(current + gallons, app.FUEL_CAPACITY);
    }
    document.getElementById('addFuelPreview').textContent =
        `Current: ${current.toFixed(1)} gal -> After: ${after.toFixed(1)} gal`;
}

function submitAddFuel() {
    const gallons = parseFloat(document.getElementById('addFuelGallons').value);
    if (!gallons || gallons <= 0) {
        alert('Please enter a valid gallons amount');
        return;
    }

    const airport = document.getElementById('addFuelAirport').value.toUpperCase();
    const setTotal = document.querySelector('input[name="addFuelMode"]:checked').value === 'set';
    const includeCalibration = document.getElementById('addFuelCalibration').checked;

    app.addFuelOffline(gallons, airport, setTotal, includeCalibration);
    closeAddFuelModal();
}

function updateCalculation() {
    app.updateCalculation();
}

// Pre-Flight Fuel Check functions
function updateTicConversion() {
    const leftTic = parseFloat(document.getElementById('leftTicInput').value) || 0;
    const rightTic = parseFloat(document.getElementById('rightTicInput').value) || 0;

    const ticResults = document.getElementById('ticResults');

    if (leftTic > 0 || rightTic > 0) {
        const leftGal = app.ticToGallons(leftTic);
        const rightGal = app.ticToGallons(rightTic);
        const total = leftGal + rightGal;

        document.getElementById('leftGallonsResult').textContent = `${leftGal.toFixed(2)} gal`;
        document.getElementById('rightGallonsResult').textContent = `${rightGal.toFixed(2)} gal`;
        document.getElementById('totalMeasuredResult').textContent = `${total.toFixed(2)} gal`;
        ticResults.style.display = 'block';
    } else {
        ticResults.style.display = 'none';
    }
}

function saveFuelMeasurement() {
    const leftTic = parseFloat(document.getElementById('leftTicInput').value) || 0;
    const rightTic = parseFloat(document.getElementById('rightTicInput').value) || 0;
    const notes = document.getElementById('measurementNotes').value || '';

    if (leftTic <= 0 && rightTic <= 0) {
        alert('Please enter at least one tic mark reading');
        return;
    }

    const measurement = app.saveMeasurement(leftTic, rightTic, notes);

    // Clear inputs
    document.getElementById('leftTicInput').value = '';
    document.getElementById('rightTicInput').value = '';
    document.getElementById('measurementNotes').value = '';
    document.getElementById('ticResults').style.display = 'none';

    // Update UI
    updateFuelCheckUI();

    // Show confirmation
    if (app.isOnline) {
        alert(`Measurement saved: ${measurement.totalMeasured} gal (compared to EDM: ${measurement.edmReading} gal)`);
    } else {
        alert(`Measurement saved: ${measurement.totalMeasured} gal (will compare to EDM when connected)`);
    }
}

function updateFuelCheckUI() {
    const pending = app.getPendingMeasurement();
    const pendingIndicator = document.getElementById('pendingMeasurement');
    const comparisonDiv = document.getElementById('edmComparison');

    // Show pending measurement indicator
    if (pending && !pending.comparedToEdm) {
        if (pendingIndicator) {
            pendingIndicator.style.display = 'block';
            pendingIndicator.innerHTML = `
                <strong>Pending:</strong> ${pending.totalMeasured} gal measured
                <br><small>${new Date(pending.timestamp).toLocaleString()}</small>
            `;
        }
        if (comparisonDiv) {
            comparisonDiv.style.display = 'none';
        }
    } else if (pending && pending.comparedToEdm) {
        // Show comparison result
        if (pendingIndicator) {
            pendingIndicator.style.display = 'none';
        }
        if (comparisonDiv) {
            const grade = app.getAccuracyGrade(pending.variancePercent);
            const sign = pending.variance >= 0 ? '+' : '';
            comparisonDiv.style.display = 'block';
            comparisonDiv.innerHTML = `
                <div class="comparison-row">
                    <span>EDM Reading:</span>
                    <span class="comparison-value">${pending.edmReading.toFixed(1)} gal</span>
                </div>
                <div class="comparison-row">
                    <span>Measured:</span>
                    <span class="comparison-value">${pending.totalMeasured.toFixed(1)} gal</span>
                </div>
                <div class="comparison-row">
                    <span>Difference:</span>
                    <span class="comparison-value">${sign}${pending.variance.toFixed(1)} gal (${sign}${pending.variancePercent.toFixed(1)}%)</span>
                </div>
                <div class="accuracy-badge" style="background:${grade.bgColor};color:${grade.color};">
                    ${grade.text}
                </div>
            `;
        }
    } else {
        // No pending measurement
        if (pendingIndicator) {
            pendingIndicator.style.display = 'none';
        }
        if (comparisonDiv) {
            comparisonDiv.style.display = 'none';
        }
    }

    // Update measurement count
    const measurementCount = document.getElementById('measurementCount');
    if (measurementCount) {
        const count = app.getMeasurementHistory().length;
        measurementCount.textContent = count > 0 ? `${count} measurements saved` : '';
    }
}

function updateEdmToMatch() {
    const pending = app.getPendingMeasurement();
    if (pending && pending.comparedToEdm && app.isOnline) {
        app.setFuel(pending.totalMeasured);
        app.clearPendingMeasurement();
        updateFuelCheckUI();
        alert(`EDM fuel updated to ${pending.totalMeasured.toFixed(1)} gal`);
    }
}

function dismissComparison() {
    app.clearPendingMeasurement();
    updateFuelCheckUI();
}

function exportFuelCSV() {
    app.exportToCSV();
}
