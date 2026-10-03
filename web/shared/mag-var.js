/**
 * FlyTab — magnetic variation from the World Magnetic Model 2025 (valid 2025.0-2030.0).
 *
 * Vendored from the npm package magvar@2.2.0 (https://github.com/dpyeates/magvar,
 * src/WMMCOF2025.js + src/utils.js + src/magvar.js), unchanged except that the
 * CommonJS require/exports are replaced by this classic-script wrapper (no
 * bundler; loaded by a <script> tag). Verified against the NOAA WMM2025 test
 * values in tests/shared/mag-var.test.js.
 *
 * Offline: pure computation, no network — usable in flight.
 *
 * Exposes window.MagVar:
 *   MagVar.declination(lat, lon, when?)  degrees, EAST positive (west negative);
 *                                        when = Date or decimal year, default now
 *   MagVar.MODEL_EPOCH, MagVar.MODEL_VALID_UNTIL
 *
 * Aviation convention: magnetic = true - declination (east) / true + variation (west);
 * i.e. magnetic = true - MagVar.declination(...).
 *
 * magvar license:
 * MIT License
 *
 * Copyright (c) 2025 Darren Yeates
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const MagVar = (() => {
// ---- src/WMMCOF2025.js ----
// WMM _2025 coefficients
const gnmWmm = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-29351.8, -1410.8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-2556.6, 2951.1, 1649.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [1361.0, -2404.1, 1243.8, 453.6, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [895.0, 799.5, 55.7, -281.1, 12.1, 0, 0, 0, 0, 0, 0, 0, 0],
  [-233.2, 368.9, 187.2, -138.7, -142.0, 20.9, 0, 0, 0, 0, 0, 0, 0],
  [64.4, 63.8, 76.9, -115.7, -40.9, 14.9, -60.7, 0, 0, 0, 0, 0, 0],
  [79.5, -77.0, -8.8, 59.3, 15.8, 2.5, -11.1, 14.2, 0, 0, 0, 0, 0],
  [23.2, 10.8, -17.5, 2.0, -21.7, 16.9, 15.0, -16.8, 0.9, 0, 0, 0, 0],
  [4.6, 7.8, 3.0, -0.2, -2.5, -13.1, 2.4, 8.6, -8.7, -12.9, 0, 0, 0],
  [-1.3, -6.4, 0.2, 2.0, -1.0, -0.6, -0.9, 1.5, 0.9, -2.7, -3.9, 0, 0],
  [2.9, -1.5, -2.5, 2.4, -0.6, -0.1, -0.6, -0.1, 1.1, -1.0, -0.2, 2.6, 0],
  [-2.0, -0.2, 0.3, 1.2, -1.3, 0.6, 0.6, 0.5, -0.1, -0.4, -0.2, -1.3, -0.7]
];

const hnmWmm = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 4545.4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, -3133.6, -815.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, -56.6, 237.5, -549.5, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 278.6, -133.9, 212.0, -375.6, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 45.4, 220.2, -122.9, 43.0, 106.1, 0, 0, 0, 0, 0, 0, 0],
  [0, -18.4, 16.8, 48.8, -59.8, 10.9, 72.7, 0, 0, 0, 0, 0, 0],
  [0, -48.9, -14.4, -1.0, 23.4, -7.4, -25.1, -2.3, 0, 0, 0, 0, 0],
  [0, 7.1, -12.6, 11.4, -9.7, 12.7, 0.7, -5.2, 3.9, 0, 0, 0, 0],
  [0, -24.8, 12.2, 8.3, -3.3, -5.2, 7.2, -0.6, 0.8, 10.0, 0, 0, 0],
  [0, 3.3, 0.0, 2.4, 5.3, -9.1, 0.4, -4.2, -3.8, 0.9, -9.1, 0, 0],
  [0, 0, 2.9, -0.6, 0.2, 0.5, -0.3, -1.2, -1.7, -2.9, -1.8, -2.3, 0],
  [0, -1.3, 0.7, 1.0, -1.4, 0.0, 0.6, -0.1, 0.8, 0.1, -1.0, 0.1, 0.2]
];

const gtnmWmm = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [12.0, 9.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-11.6, -5.2, -8.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-1.3, -4.2, 0.4, -15.6, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-1.6, -2.4, -6.0, 5.6, -7.0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0.6, 1.4, 0.0, 0.6, 2.2, 0.9, 0, 0, 0, 0, 0, 0, 0],
  [-0.2, -0.4, 0.9, 1.2, -0.9, 0.3, 0.9, 0, 0, 0, 0, 0, 0],
  [-0, -0.1, -0.1, 0.5, -0.1, -0.8, -0.8, 0.8, 0, 0, 0, 0, 0],
  [-0.1, 0.2, 0.0, 0.5, -0.1, 0.3, 0.2, -0, 0.2, 0, 0, 0, 0],
  [-0, -0.1, 0.1, 0.3, -0.3, 0, 0.3, -0.1, 0.1, -0.1, 0, 0, 0],
  [0.1, 0.0, 0.1, 0.1, -0, -0.3, 0, -0.1, -0.1, -0, -0, 0, 0],
  [0, -0, 0, 0, 0, -0.1, 0, -0, -0.1, -0.1, -0.1, -0.1, 0],
  [0, 0, -0, -0, -0, -0, 0.1, -0, 0, 0, -0.1, -0, -0.1]
];

const htnmWmm = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, -21.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, -27.7, -12.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 4.0, -0.3, -4.1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, -1.1, 4.1, 1.6, -4.4, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, -0.5, 2.2, 0.4, 1.7, 1.9, 0, 0, 0, 0, 0, 0, 0],
  [0, 0.3, -1.6, -0.4, 0.9, 0.7, 0.9, 0, 0, 0, 0, 0, 0],
  [0, 0.6, 0.5, -0.8, 0.0, -1.0, 0.6, -0.2, 0, 0, 0, 0, 0],
  [0, -0.2, 0.5, -0.4, 0.4, -0.5, -0.6, 0.3, 0.2, 0, 0, 0, 0],
  [0, -0.3, 0.3, -0.3, 0.3, 0.2, -0.1, -0.2, 0.4, 0.1, 0, 0, 0],
  [0, 0, -0, -0.2, 0.1, -0.1, 0.1, 0.0, -0.1, 0.2, -0, 0, 0],
  [0, -0, 0.1, -0, 0.1, -0, -0, 0.1, -0, 0, 0, 0, 0],
  [0, -0, 0, -0.1, 0.1, -0, -0, -0, 0, -0, -0, 0, -0.1]
];

const julianDaysCOF = 2460677;
// (were properties of the source's module.exports)
const MODEL_EPOCH = 2025.0;
const MODEL_VALID_UNTIL = 2030.0;



// ---- src/utils.js ----
const DEG_TO_RAD = 0.017453292519943295;
const RAD_TO_DEG = 57.29577951308232;

const roundToDecimalPlace = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Convert a Gregorian calendar date to Julian Day Number at 00:00 UTC.
 * @param {number} year full year (e.g. 2025)
 * @param {number} month 0-indexed month (0 = January), matching `Date.getUTCMonth()`
 * @param {number} day day of month (1-31)
 * @returns {number} Julian Day Number at 00:00 UTC
 */
const gregorianToJulian = (year, month, day) =>
  Date.UTC(year, month, day) / 86400000 + 2440587.5;

/**
 * Convert a Date to a decimal year in UTC (e.g. mid-2025 → ~2025.5).
 * @param {Date} [date]
 * @returns {number}
 */
const dateToDecimalYear = (date = new Date()) => {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const next = Date.UTC(year + 1, 0, 1);
  const current = Date.UTC(
    year,
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  );
  return year + (current - start) / (next - start);
};

/**
 * Resolve a date input to a WMM decimal year.
 * @param {number|Date} [when] decimal year, Date, or omit for now
 * @returns {number}
 */
const resolveDecimalYear = (when) => {
  if (when === undefined || when === null) {
    return dateToDecimalYear(new Date());
  }
  if (when instanceof Date) {
    return dateToDecimalYear(when);
  }
  if (typeof when === 'number' && Number.isFinite(when)) {
    return when;
  }
  throw new TypeError('when must be a decimal year number or Date');
};

const zeroArray2D = (rows, columns) =>
  Array.from({ length: rows }, () => Array(columns).fill(0));
// (were properties of the source's module.exports)
const deg2rad = (degrees) => degrees * DEG_TO_RAD;
const rad2deg = (radians) => radians * RAD_TO_DEG;



// ---- src/magvar.js ----
const MAX_N = 12;
const SIZE = MAX_N + 1;

const globe = {
  a: 6378.137, // semi-major axis [equatorial radius] of WGS84 ellipsoid (km)
  b: 6356.7523142, // semi-minor axis referenced to the WGS84 ellipsoid (km)
  r0: 6371.2 // "mean radius" for spherical harmonic expansion (km)
};

// Scratch arrays reused across calls (single-threaded JS; not worker-safe).
const P = zeroArray2D(SIZE, SIZE);
const DP = zeroArray2D(SIZE, SIZE);
const gnm = zeroArray2D(SIZE, SIZE);
const hnm = zeroArray2D(SIZE, SIZE);
const sm = new Array(SIZE).fill(0);
const cm = new Array(SIZE).fill(0);
const root = new Array(SIZE).fill(0);
const roots = zeroArray2D(SIZE, SIZE).map((row) => row.map(() => [0, 0]));

for (let n = 2; n <= MAX_N; n++) {
  root[n] = Math.sqrt((2.0 * n - 1) / (2.0 * n));
}

for (let m = 0; m <= MAX_N; m++) {
  const mm = m * m;
  for (let n = Math.max(m + 1, 2); n <= MAX_N; n++) {
    roots[m][n][0] = Math.sqrt((n - 1) * (n - 1) - mm);
    roots[m][n][1] = 1.0 / Math.sqrt(n * n - mm);
  }
}

let cachedDecimalYear = Number.NaN;
let warnedOutsideValidity = false;

const warnIfOutsideValidity = (decimalYear) => {
  if (
    !warnedOutsideValidity &&
    (decimalYear < MODEL_EPOCH || decimalYear >= MODEL_VALID_UNTIL)
  ) {
    warnedOutsideValidity = true;
    console.warn(
      `magvar: decimal year ${decimalYear} is outside the WMM ${MODEL_EPOCH}-${MODEL_VALID_UNTIL} validity period; results may be inaccurate.`
    );
  }
};

const updateSecularVariation = (decimalYear) => {
  if (decimalYear === cachedDecimalYear) {
    return;
  }
  cachedDecimalYear = decimalYear;
  const yearFrac = decimalYear - MODEL_EPOCH;
  for (let n = 1; n <= MAX_N; n++) {
    for (let m = 0; m <= n; m++) {
      gnm[n][m] = gnmWmm[n][m] + yearFrac * gtnmWmm[n][m];
      hnm[n][m] = hnmWmm[n][m] + yearFrac * htnmWmm[n][m];
    }
  }
};

/**
 * Compute geomagnetic field components for a decimal year.
 * @param {number} decimalYear WMM decimal year (e.g. 2025.0, 2027.5)
 * @param {number} latitude geodetic latitude in degrees (N positive)
 * @param {number} longitude geodetic longitude in degrees (E positive)
 * @param {number} [altitude=0] height in kilometers above mean sea level
 * @returns {{
 *   declination: number,
 *   inclination: number,
 *   x: number,
 *   y: number,
 *   z: number,
 *   h: number,
 *   f: number,
 *   decimalYear: number
 * }} field components (angles in degrees, intensities in nT)
 */
const calculateMagneticField = (decimalYear, latitude, longitude, altitude = 0) => {
  warnIfOutsideValidity(decimalYear);
  updateSecularVariation(decimalYear);

  const latRad = deg2rad(latitude);
  const lonRad = deg2rad(longitude);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sr = Math.sqrt(globe.a ** 2 * cosLat ** 2 + globe.b ** 2 * sinLat ** 2);
  const theta = Math.atan2(
    cosLat * (altitude * sr + globe.a ** 2),
    sinLat * (altitude * sr + globe.b ** 2)
  );
  const r = Math.sqrt(
    altitude ** 2 +
      2 * altitude * sr +
      (globe.a ** 4 - (globe.a ** 4 - globe.b ** 4) * sinLat ** 2) /
        (globe.a ** 2 - (globe.a ** 2 - globe.b ** 2) * sinLat ** 2)
  );
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const invS = 1 / (s + (s === 0 ? 1e-8 : 0));

  P[0][0] = 1.0;
  P[1][1] = s;
  DP[0][0] = 0.0;
  DP[1][1] = c;
  P[1][0] = c;
  DP[1][0] = -s;

  for (let n = 2; n <= MAX_N; n++) {
    P[n][n] = P[n - 1][n - 1] * s * root[n];
    DP[n][n] = (DP[n - 1][n - 1] * s + P[n - 1][n - 1] * c) * root[n];
  }

  for (let m = 0; m <= MAX_N; m++) {
    for (let n = Math.max(m + 1, 2); n <= MAX_N; n++) {
      P[n][m] =
        (P[n - 1][m] * c * (2 * n - 1) - P[n - 2][m] * roots[m][n][0]) *
        roots[m][n][1];
      DP[n][m] =
        ((DP[n - 1][m] * c - P[n - 1][m] * s) * (2 * n - 1) -
          DP[n - 2][m] * roots[m][n][0]) *
        roots[m][n][1];
    }
  }

  for (let m = 0; m <= MAX_N; m++) {
    sm[m] = Math.sin(m * lonRad);
    cm[m] = Math.cos(m * lonRad);
  }

  let BR = 0.0;
  let BTheta = 0.0;
  let BPhi = 0.0;
  const fn0 = globe.r0 / r;
  let fn = fn0 ** 2;

  for (let n = 1; n <= MAX_N; n++) {
    let c1n = 0;
    let c2n = 0;
    let c3n = 0;
    for (let m = 0; m <= n; m++) {
      const tmp = gnm[n][m] * cm[m] + hnm[n][m] * sm[m];
      c1n += tmp * P[n][m];
      c2n += tmp * DP[n][m];
      c3n += m * (gnm[n][m] * sm[m] - hnm[n][m] * cm[m]) * P[n][m];
    }
    fn *= fn0;
    BR += (n + 1) * c1n * fn;
    BTheta -= c2n * fn;
    BPhi += c3n * fn * invS;
  }

  const psi = theta - (Math.PI / 2 - latRad);
  const sinPsi = Math.sin(psi);
  const cosPsi = Math.cos(psi);
  const x = -BTheta * cosPsi - BR * sinPsi;
  const y = BPhi;
  const z = BTheta * sinPsi - BR * cosPsi;
  const h = Math.hypot(x, y);
  const f = Math.hypot(h, z);
  const declination =
    x !== 0.0 || y !== 0.0 ? rad2deg(Math.atan2(y, x)) : 0.0;
  const inclination = h !== 0.0 || z !== 0.0 ? rad2deg(Math.atan2(z, h)) : 0.0;

  return {
    declination: roundToDecimalPlace(declination, 2),
    inclination: roundToDecimalPlace(inclination, 2),
    x: roundToDecimalPlace(x, 1),
    y: roundToDecimalPlace(y, 1),
    z: roundToDecimalPlace(z, 1),
    h: roundToDecimalPlace(h, 1),
    f: roundToDecimalPlace(f, 1),
    decimalYear
  };
};

/**
 * Given a decimal year, latitude, longitude and optional height in km above MSL,
 * return magnetic variation (declination) in degrees.
 * @param {number} decimalYear
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} [altitude=0] height in kilometers above mean sea level
 * @returns {number} magnetic variation in degrees
 */
const calculateMagVarForDecimalYear = (
  decimalYear,
  latitude,
  longitude,
  altitude = 0
) => calculateMagneticField(decimalYear, latitude, longitude, altitude).declination;

/**
 * Given a Julian day, latitude, longitude and optional height in km above MSL,
 * return magnetic variation (declination) in degrees.
 * Prefer `magvar` or `calculateMagVarForDecimalYear` for new code.
 * @param {number} julianDays Julian Day Number
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} [altitude=0] height in kilometers above mean sea level
 * @returns {number} magnetic variation in degrees
 */
const calculateMagVar = (julianDays, latitude, longitude, altitude = 0) => {
  const decimalYear = MODEL_EPOCH + (julianDays - julianDaysCOF) / 365.25;
  return calculateMagVarForDecimalYear(
    decimalYear,
    latitude,
    longitude,
    altitude
  );
};

/**
 * Magnetic variation (declination) for a location.
 * North and east latitudes/longitudes are positive; south and west are negative.
 * @param {number} latitude degrees
 * @param {number} longitude degrees
 * @param {number} [altitude=0] height in kilometers above mean sea level
 * @param {number|Date} [when] decimal year (e.g. 2026.5) or Date; defaults to current UTC time
 * @returns {number} magnetic variation in degrees
 */
const magvar = (latitude, longitude, altitude = 0, when) =>
  calculateMagVarForDecimalYear(
    resolveDecimalYear(when),
    latitude,
    longitude,
    altitude
  );

/**
 * Full geomagnetic field for a location.
 * @param {number} latitude degrees
 * @param {number} longitude degrees
 * @param {number} [altitude=0] height in kilometers above mean sea level
 * @param {number|Date} [when] decimal year or Date; defaults to current UTC time
 */
const magneticField = (latitude, longitude, altitude = 0, when) =>
  calculateMagneticField(
    resolveDecimalYear(when),
    latitude,
    longitude,
    altitude
  );



return {
    declination: (latitude, longitude, when) => magvar(latitude, longitude, 0, when),
    magneticField,
    calculateMagVarForDecimalYear,
    MODEL_EPOCH,
    MODEL_VALID_UNTIL,
};
})();
