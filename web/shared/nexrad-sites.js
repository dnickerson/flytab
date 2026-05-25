/**
 * NEXRAD WSR-88D site locations (SE US coverage) and beam height math.
 */

const NEXRAD_SITES = [
    { id: 'KGSP', lat: 34.8833, lon: -82.2203, elevFt: 940  },
    { id: 'KCAE', lat: 33.9488, lon: -81.1184, elevFt: 231  },
    { id: 'KCLX', lat: 32.6558, lon: -81.0422, elevFt: 97   },
    { id: 'KJGX', lat: 32.6750, lon: -83.3511, elevFt: 521  },
    { id: 'KFFC', lat: 33.3636, lon: -84.5658, elevFt: 858  },
    { id: 'KLTX', lat: 33.9891, lon: -78.4291, elevFt: 61   },
    { id: 'KRAX', lat: 35.6654, lon: -78.4897, elevFt: 348  },
    { id: 'KMHX', lat: 34.7759, lon: -76.8762, elevFt: 31   },
    { id: 'KAKQ', lat: 36.9839, lon: -77.0075, elevFt: 112  },
    { id: 'KCCX', lat: 40.9228, lon: -78.0039, elevFt: 2405 },
    { id: 'KDOX', lat: 38.8257, lon: -75.4400, elevFt: 50   },
    { id: 'KICT', lat: 37.6544, lon: -97.4428, elevFt: 1335 },
    { id: 'KVAX', lat: 30.8903, lon: -83.0019, elevFt: 178  },
    { id: 'KAMX', lat: 25.6111, lon: -80.4128, elevFt: 14   },
    { id: 'KTBW', lat: 27.7056, lon: -82.4019, elevFt: 41   },
    { id: 'KEVX', lat: 30.5644, lon: -85.9219, elevFt: 140  },
    { id: 'KMOB', lat: 30.6794, lon: -88.2397, elevFt: 208  },
    { id: 'KBMX', lat: 33.1722, lon: -86.7697, elevFt: 1220 },
    { id: 'KHTX', lat: 34.9306, lon: -86.0836, elevFt: 1760 },
    { id: 'KOHX', lat: 36.2472, lon: -86.5625, elevFt: 576  },
];

/**
 * Standard atmosphere beam height, 4/3 Earth radius model.
 * Returns feet AGL at the given slant range from the radar site.
 * @param {number} distanceNm  - slant range in nautical miles
 * @param {number} [elevDeg=0.5] - elevation angle in degrees
 * @returns {number} beam height in feet
 */
function getBeamHeightFt(distanceNm, elevDeg = 0.5) {
    const distM = distanceNm * 1852;
    const Re = 6371000 * (4 / 3);  // effective Earth radius
    const elevRad = elevDeg * Math.PI / 180;
    const heightM = Math.sqrt(
        distM ** 2 + Re ** 2 + 2 * distM * Re * Math.sin(elevRad)
    ) - Re;
    return heightM * 3.28084;
}

/**
 * Find the NEXRAD site nearest to a lat/lon position.
 * @param {{ lat: number, lon: number }} pos
 * @returns {{ id, lat, lon, elevFt }}
 */
function findNearestNexradSite(pos) {
    let nearest = NEXRAD_SITES[0];
    let bestDist = _distDeg(pos, nearest);
    for (const site of NEXRAD_SITES) {
        const d = _distDeg(pos, site);
        if (d < bestDist) { bestDist = d; nearest = site; }
    }
    return nearest;
}

/**
 * Returns beam height warning if beam clears 4,000 ft above the return position.
 * @param {{ lat, lon }} returnPos
 * @param {{ lat, lon }} aircraftPos
 * @param {{ lat, lon, elevFt }} [site]  defaults to nearest NEXRAD site
 * @returns {{ beamHeightFt: number, warning: string|null }}
 */
function getBeamHeightWarning(returnPos, aircraftPos, site) {
    const s = site || findNearestNexradSite(returnPos);
    const distNm = _nmBetween(returnPos, s);
    const beamHeightFt = getBeamHeightFt(distNm);
    return {
        beamHeightFt,
        warning: beamHeightFt > 4000
            ? `Radar beam ${Math.round(beamHeightFt / 100) * 100}ft — hazard extends below`
            : null,
    };
}

/**
 * Return all NEXRAD sites within a bounding box (+ 1° buffer).
 */
function findNexradSitesInBbox({ minLat, maxLat, minLon, maxLon }) {
    const B = 1;
    return NEXRAD_SITES.filter(s =>
        s.lat >= minLat - B && s.lat <= maxLat + B &&
        s.lon >= minLon - B && s.lon <= maxLon + B
    );
}

function _distDeg(a, b) {
    return Math.sqrt((a.lat - b.lat) ** 2 + (a.lon - b.lon) ** 2);
}

function _nmBetween(a, b) {
    const R = 3440.065;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
