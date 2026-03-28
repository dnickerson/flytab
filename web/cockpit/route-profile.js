/**
 * FlyTab — Route Profile View  v1.0
 * Floating terrain/altitude profile chart that appears above the route-table sheet.
 * No external libraries — canvas 2D API only.
 */

class RouteProfileView {
    constructor() {
        this._el       = null;
        this._canvas   = null;
        this._tooltip  = null;
        this._chevronBtn = null;
        this._routeData  = null;
        this._expanded   = false;
        this._visible    = false;
        this._scrubX     = null;

        this._buildDOM();
    }

    show(routeData) {
        this._routeData = routeData;
        this._el.style.display = 'flex';
        this._visible = true;
        // Populate terrain profile from in-memory grid if not already provided
        if ((!routeData.terrainProfile || routeData.terrainProfile.length === 0) && routeData.coords) {
            routeData.terrainProfile = this._fetchTerrainProfile(routeData.coords);
        }
        // Defer render until layout is complete so offsetWidth/Height are valid
        requestAnimationFrame(() => this._render(routeData));
    }

    hide() {
        this._el.style.display = 'none';
        this._visible = false;

    }

    // ── DOM ──────────────────────────────────────────────────────────────────

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'route-profile-panel';
        Object.assign(this._el.style, {
            position:        'fixed',
            bottom:          'var(--tab-bar-height, 72px)',
            left:            '0',
            right:           '0',
            height:          '180px',
            background:      'var(--bg-primary, #111)',
            borderTop:       '2px solid var(--accent, #00aaff)',
            display:         'none',
            flexDirection:   'column',
            overflow:        'hidden',
            zIndex:          '600',
            touchAction:     'none',
            boxShadow:       '0 -4px 16px rgba(0,0,0,0.5)',
        });

        // Header bar
        const header = document.createElement('div');
        Object.assign(header.style, {
            display:       'flex',
            alignItems:    'center',
            padding:       '3px 8px',
            gap:           '6px',
            flexShrink:    '0',
            borderBottom:  '1px solid var(--border-strong, #333)',
        });

        const titleEl = document.createElement('span');
        titleEl.textContent = '\u26F0 Profile';
        Object.assign(titleEl.style, {
            fontSize:   '13px',
            fontWeight: '600',
            color:      'var(--text-primary)',
            flex:       '1',
        });

        this._chevronBtn = document.createElement('button');
        this._chevronBtn.textContent = '\u25B2';
        this._chevronBtn.title = 'Expand/collapse';
        this._styleIconBtn(this._chevronBtn);
        this._chevronBtn.addEventListener('click', () => this._toggleExpand());

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u2715';
        closeBtn.title = 'Close';
        this._styleIconBtn(closeBtn);
        closeBtn.addEventListener('click', () => this.hide());

        header.appendChild(titleEl);
        header.appendChild(this._chevronBtn);
        header.appendChild(closeBtn);

        // Canvas
        this._canvas = document.createElement('canvas');
        Object.assign(this._canvas.style, {
            flex:      '1',
            width:     '100%',
            minHeight: '0',   // critical: allows flex child to shrink inside fixed-height panel
            display:   'block',
        });

        // Touch scrubber
        this._canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this._updateScrub(e);
        }, { passive: false });
        this._canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            this._updateScrub(e);
        }, { passive: false });
        this._canvas.addEventListener('touchend', () => {
            this._scrubX = null;
            if (this._routeData) this._render(this._routeData);
        });

        // Tooltip
        this._tooltip = document.createElement('div');
        Object.assign(this._tooltip.style, {
            position:    'absolute',
            background:  'var(--bg-surface-raised, #2a2a2a)',
            border:      '1px solid var(--border-strong, #444)',
            borderRadius:'4px',
            padding:     '3px 7px',
            fontSize:    '11px',
            color:       'var(--text-primary)',
            pointerEvents:'none',
            display:     'none',
            whiteSpace:  'nowrap',
            zIndex:      '1',
        });

        this._el.appendChild(header);
        this._el.appendChild(this._canvas);
        this._el.appendChild(this._tooltip);

        // Prevent scroll passthrough from the panel to the map
        this._el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

        document.body.appendChild(this._el);
    }

    _styleIconBtn(btn) {
        Object.assign(btn.style, {
            background:  'none',
            border:      'none',
            color:       'var(--text-secondary)',
            fontSize:    '13px',
            padding:     '4px 6px',
            cursor:      'pointer',
            lineHeight:  '1',
            flexShrink:  '0',
        });
    }

    _toggleExpand() {
        this._expanded = !this._expanded;
        const h = this._expanded ? 280 : 180;
        this._el.style.height = h + 'px';
        this._chevronBtn.textContent = this._expanded ? '\u25BC' : '\u25B2';
        if (this._routeData) requestAnimationFrame(() => this._render(this._routeData));
    }

    _updateScrub(e) {
        const rect = this._canvas.getBoundingClientRect();
        this._scrubX = e.touches[0].clientX - rect.left;
        if (this._routeData) this._render(this._routeData);
    }

    // ── Render ───────────────────────────────────────────────────────────────

    _render(routeData) {
        if (!routeData) return;

        const canvas = this._canvas;
        const dpr    = window.devicePixelRatio || 1;
        const w      = canvas.offsetWidth;
        const h      = canvas.offsetHeight;
        if (w < 10 || h < 10) return;

        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const pad = { top: 10, right: 10, bottom: 28, left: 44 };
        const cw  = w - pad.left - pad.right;
        const ch  = h - pad.top  - pad.bottom;
        if (cw <= 0 || ch <= 0) return;

        const totalDist  = Math.max(1, routeData.totalDistNm || 1);
        const cruiseAlt  = routeData.cruiseAltFt || 10000;
        const terrain    = routeData.terrainProfile || [];

        const maxTerrain = terrain.length > 0
            ? Math.max(...terrain.map(p => p.elev_ft))
            : cruiseAlt * 0.3;
        const yMax = Math.max(maxTerrain, cruiseAlt) * 1.15;

        const xOf = (dist) => pad.left + (dist / totalDist) * cw;
        const yOf = (alt)  => pad.top  + ch - (alt  / yMax)  * ch;

        ctx.clearRect(0, 0, w, h);

        // 1. Terrain fill ────────────────────────────────────────────────────
        if (terrain.length > 0) {
            this._drawTerrainFill(ctx, terrain, xOf, yOf);
        } else {
            this._drawMockTerrain(ctx, totalDist, xOf, yOf, yMax);
        }

        // 1b. Airspace bands (after terrain, before flight path)
        if (routeData.airspaceBands?.length > 0) {
            this._drawAirspaceBands(ctx, routeData.airspaceBands, xOf, yOf);
        }

        // 2. Build flight altitude profile (needed for danger zone calc)
        const flightPath = this._buildFlightPath(routeData, totalDist);

        // 3. Danger zones ────────────────────────────────────────────────────
        const dangerSegs = [];
        if (terrain.length > 0 && flightPath.length > 0) {
            for (let i = 0; i < terrain.length; i++) {
                const pt = terrain[i];
                const flightAlt = this._interpValue(flightPath, pt.dist_nm, 'dist', 'alt');
                if (flightAlt === null) continue;
                const clearance = flightAlt - pt.elev_ft;
                if (clearance < 1000) {
                    const next = terrain[i + 1] || pt;
                    dangerSegs.push({
                        distFrom:    pt.dist_nm,
                        distTo:      next.dist_nm,
                        terrainFrom: pt.elev_ft,
                        terrainTo:   next.elev_ft,
                        severity:    clearance < 0 ? 'critical' : 'warning',
                    });
                }
            }
        }
        if (dangerSegs.length > 0) {
            ctx.save();
            // Warning zones (< 1000ft clearance)
            ctx.beginPath();
            for (const seg of dangerSegs.filter(s => s.severity === 'warning')) {
                ctx.moveTo(xOf(seg.distFrom), yOf(seg.terrainFrom));
                ctx.lineTo(xOf(seg.distTo),   yOf(seg.terrainTo));
                ctx.lineTo(xOf(seg.distTo),   yOf(0));
                ctx.lineTo(xOf(seg.distFrom), yOf(0));
                ctx.closePath();
            }
            ctx.fillStyle = 'rgba(239,68,68,0.75)';
            ctx.fill();
            // Critical zones (below terrain — actual collision)
            ctx.beginPath();
            for (const seg of dangerSegs.filter(s => s.severity === 'critical')) {
                ctx.moveTo(xOf(seg.distFrom), yOf(seg.terrainFrom));
                ctx.lineTo(xOf(seg.distTo),   yOf(seg.terrainTo));
                ctx.lineTo(xOf(seg.distTo),   yOf(0));
                ctx.lineTo(xOf(seg.distFrom), yOf(0));
                ctx.closePath();
            }
            ctx.fillStyle = 'rgba(180,0,0,1.0)';
            ctx.fill();
            ctx.restore();
        }

        // 4. Freezing level line ─────────────────────────────────────────────
        if (routeData.freezingLevelFt) {
            const fy = yOf(routeData.freezingLevelFt);
            if (fy > pad.top && fy < h - pad.bottom) {
                ctx.save();
                ctx.strokeStyle = '#818cf8';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(pad.left, fy);
                ctx.lineTo(pad.left + cw, fy);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#818cf8';
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText('FZL', pad.left + 2, fy - 3);
                ctx.restore();
            }
        }

        // 5. Cloud layers ────────────────────────────────────────────────────
        if (routeData.cloudLayers?.length) {
            ctx.fillStyle = 'rgba(148,163,184,0.4)';
            for (const cl of routeData.cloudLayers) {
                const cx = xOf(cl.dist_nm);
                const y1 = yOf(cl.top_ft);
                const y2 = yOf(cl.base_ft);
                ctx.fillRect(cx - 20, y1, 40, Math.max(1, y2 - y1));
            }
        }

        // 6. Cruise altitude dashed reference ────────────────────────────────
        const cruiseY = yOf(cruiseAlt);
        ctx.save();
        ctx.strokeStyle = '#9ca3af';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, cruiseY);
        ctx.lineTo(pad.left + cw, cruiseY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // 7. Flight path line ────────────────────────────────────────────────
        if (flightPath.length > 1) {
            const phaseColors = { CLB: '#f59e0b', CRZ: '#0ea5e9', DES: '#3b82f6' };
            for (let i = 0; i < flightPath.length - 1; i++) {
                const a = flightPath[i];
                const b = flightPath[i + 1];
                ctx.strokeStyle = phaseColors[a.phase] || '#0ea5e9';
                ctx.lineWidth   = 2.5;
                ctx.lineCap     = 'round';
                ctx.beginPath();
                ctx.moveTo(xOf(a.dist), yOf(a.alt));
                ctx.lineTo(xOf(b.dist), yOf(b.alt));
                ctx.stroke();
            }
        }

        // 7b. Danger band on flight path ─────────────────────────────────────
        if (dangerSegs.length > 0 && flightPath.length > 1) {
            ctx.save();
            ctx.lineCap = 'round';
            for (const seg of dangerSegs) {
                const fa1 = this._interpValue(flightPath, seg.distFrom, 'dist', 'alt') ?? cruiseAlt;
                const fa2 = this._interpValue(flightPath, seg.distTo,   'dist', 'alt') ?? cruiseAlt;
                ctx.strokeStyle = seg.severity === 'critical' ? '#7f1d1d' : '#ef4444';
                ctx.lineWidth   = seg.severity === 'critical' ? 6 : 4;
                ctx.beginPath();
                ctx.moveTo(xOf(seg.distFrom), yOf(fa1));
                ctx.lineTo(xOf(seg.distTo),   yOf(fa2));
                ctx.stroke();
            }
            ctx.restore();
        }

        // 7c. Warning label ───────────────────────────────────────────────────
        if (dangerSegs.length > 0) {
            const hasCritical = dangerSegs.some(s => s.severity === 'critical');
            ctx.save();
            ctx.font      = 'bold 11px sans-serif';
            ctx.fillStyle = '#ef4444';
            ctx.textAlign = 'right';
            ctx.fillText(hasCritical ? '\u26A0 TERRAIN CONFLICT' : '\u26A0 TERRAIN',
                         pad.left + cw, pad.top + 13);
            ctx.restore();
        }

        // 8. Y-axis altitude labels ──────────────────────────────────────────
        ctx.fillStyle  = 'rgba(156,163,175,0.85)';
        ctx.font       = '9px sans-serif';
        ctx.textAlign  = 'right';
        const altStep  = yMax > 20000 ? 4000 : 2000;
        for (let alt = 0; alt <= yMax; alt += altStep) {
            const y = yOf(alt);
            if (y < pad.top - 2 || y > h - pad.bottom + 6) continue;
            ctx.fillText(alt === 0 ? '0' : (alt / 1000).toFixed(0) + 'k', pad.left - 3, y + 3);
        }

        // 9. Waypoint tick marks and labels ──────────────────────────────────
        if (routeData.legs?.length) {
            ctx.strokeStyle = 'rgba(100,116,139,0.35)';
            ctx.lineWidth   = 1;
            ctx.fillStyle   = 'rgba(156,163,175,0.85)';
            ctx.font        = '9px sans-serif';
            ctx.textAlign   = 'center';
            let cumDist = 0;
            for (const leg of routeData.legs) {
                const x = xOf(cumDist);
                ctx.beginPath();
                ctx.moveTo(x, pad.top);
                ctx.lineTo(x, h - pad.bottom + 3);
                ctx.stroke();
                if (leg.from) ctx.fillText(leg.from, x, h - pad.bottom + 11);
                cumDist += (leg.dist || 0);
            }
            // Final destination label
            const last = routeData.legs[routeData.legs.length - 1];
            if (last?.to) ctx.fillText(last.to, xOf(totalDist), h - pad.bottom + 11);
        }

        // 10. Distance labels along x-axis ───────────────────────────────────
        ctx.fillStyle = 'rgba(100,116,139,0.6)';
        ctx.font      = '9px sans-serif';
        ctx.textAlign = 'center';
        const distStep = Math.max(10, Math.ceil(totalDist / 5 / 10) * 10);
        for (let d = distStep; d < totalDist - distStep * 0.4; d += distStep) {
            ctx.fillText(d.toFixed(0), xOf(d), h - 5);
        }

        // 11. Touch scrubber ─────────────────────────────────────────────────
        if (this._scrubX !== null) {
            const dist = ((this._scrubX - pad.left) / cw) * totalDist;
            if (dist >= 0 && dist <= totalDist) {
                const sx = Math.round(xOf(dist));
                ctx.save();
                ctx.strokeStyle = 'rgba(255,255,255,0.45)';
                ctx.lineWidth   = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(sx, pad.top);
                ctx.lineTo(sx, h - pad.bottom);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();

                const terrainElev = terrain.length > 0
                    ? this._interpTerrain(terrain, dist)
                    : 0;
                const flightAlt  = flightPath.length > 0
                    ? (this._interpValue(flightPath, dist, 'dist', 'alt') ?? cruiseAlt)
                    : cruiseAlt;
                const clearance  = flightAlt - terrainElev;
                let tip;
                if (clearance < 0) {
                    tip = `\u26F0 CONFLICT: terrain ${terrainElev.toFixed(0)}ft > flight ${flightAlt.toFixed(0)}ft`;
                } else if (clearance < 1000) {
                    tip = `\u26A0 ${clearance.toFixed(0)}ft clearance (terrain ${terrainElev.toFixed(0)}ft, flight ${flightAlt.toFixed(0)}ft)`;
                } else {
                    tip = `${dist.toFixed(0)}nm \u2502 Terrain: ${terrainElev.toFixed(0)}ft \u2502 Flight: ${flightAlt.toFixed(0)}ft \u2502 Clear: ${clearance.toFixed(0)}ft`;
                }

                // Check if scrub position is inside any airspace band
                const activeBands = (routeData.airspaceBands || []).filter(
                    b => dist >= b.distFrom && dist <= b.distTo &&
                         flightAlt >= b.lowerFt && flightAlt <= b.upperFt
                );
                if (activeBands.length > 0) {
                    const bandStr = activeBands.map(b =>
                        `Class ${b.class} ${b.lowerFt === 0 ? 'SFC' : b.lowerFt + 'ft'}-${b.upperFt + 'ft'}`
                    ).join(', ');
                    tip += ` | ${bandStr}`;
                }

                this._tooltip.textContent = tip;
                this._tooltip.style.display = 'block';
                const tipW   = this._tooltip.offsetWidth || 260;
                const tipLeft = Math.max(pad.left, Math.min(sx, w - tipW - 4));
                this._tooltip.style.left = tipLeft + 'px';
                this._tooltip.style.top  = '30px';
            }
        } else {
            this._tooltip.style.display = 'none';
        }
    }

    // ── Drawing helpers ───────────────────────────────────────────────────────

    _drawAirspaceBands(ctx, airspaceBands, xOf, yOf) {
        if (!airspaceBands?.length) return;

        const colors = {
            B: { fill: 'rgba(0,102,204,0.15)', stroke: 'rgba(0,80,180,0.7)',  label: '#0066cc' },
            C: { fill: 'rgba(170,0,170,0.12)', stroke: 'rgba(140,0,140,0.7)', label: '#aa00aa' },
            D: { fill: 'rgba(0,80,200,0.08)',  stroke: 'rgba(0,60,160,0.6)',  label: '#0050c8' },
        };

        for (const band of airspaceBands) {
            const c = colors[band.class] || colors.D;
            const x1 = xOf(band.distFrom);
            const x2 = xOf(band.distTo);
            const yTop = yOf(band.upperFt);
            const yBot = yOf(band.lowerFt);
            const w = Math.max(2, x2 - x1);
            const h = yBot - yTop;

            if (h <= 0 || w <= 0) continue;

            // Fill
            ctx.fillStyle = c.fill;
            ctx.fillRect(x1, yTop, w, h);

            // Top and bottom borders
            ctx.strokeStyle = c.stroke;
            ctx.lineWidth = band.class === 'B' ? 1.5 : 1;
            ctx.setLineDash(band.class === 'D' ? [4, 3] : []);
            ctx.beginPath();
            ctx.moveTo(x1, yTop); ctx.lineTo(x2, yTop);  // ceiling
            ctx.moveTo(x1, yBot); ctx.lineTo(x2, yBot);  // floor
            ctx.stroke();
            ctx.setLineDash([]);

            // Side borders
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            ctx.moveTo(x1, yTop); ctx.lineTo(x1, yBot);
            ctx.moveTo(x2, yTop); ctx.lineTo(x2, yBot);
            ctx.stroke();

            // Label: class letter + floor/ceiling (e.g. "B SFC-10k")
            const labelX = x1 + (w / 2);
            const labelY = yTop + 11;
            const ceilStr  = band.upperFt >= 18000 ? 'FL180' : (band.upperFt / 1000).toFixed(0) + 'k';
            const floorStr = band.lowerFt === 0    ? 'SFC'   : (band.lowerFt / 1000).toFixed(0) + 'k';
            ctx.fillStyle = c.label;
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`${band.class} ${floorStr}-${ceilStr}`, labelX, labelY);
            ctx.textAlign = 'left';
        }
    }

    _drawTerrainFill(ctx, terrain, xOf, yOf) {
        ctx.beginPath();
        ctx.moveTo(xOf(terrain[0].dist_nm), yOf(terrain[0].elev_ft));
        for (let i = 1; i < terrain.length; i++) {
            ctx.lineTo(xOf(terrain[i].dist_nm), yOf(terrain[i].elev_ft));
        }
        ctx.lineTo(xOf(terrain[terrain.length - 1].dist_nm), yOf(0));
        ctx.lineTo(xOf(terrain[0].dist_nm), yOf(0));
        ctx.closePath();
        ctx.fillStyle   = 'rgba(160,120,80,0.8)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(120,80,40,1)';
        ctx.lineWidth   = 1;
        ctx.stroke();
    }

    _drawMockTerrain(ctx, totalDist, xOf, yOf, yMax) {
        const N  = 60;
        const pts = [];
        for (let i = 0; i <= N; i++) {
            const x = i / N;
            const d = x * totalDist;
            const base  = yMax * 0.08;
            const ridge = yMax * 0.50 * Math.exp(-Math.pow((x - 0.4) * 4, 2));
            const wave  = yMax * 0.12 * Math.sin(x * Math.PI * 5);
            const e     = Math.max(0, base + ridge + wave);
            pts.push({ dist_nm: d, elev_ft: e });
        }
        ctx.beginPath();
        ctx.moveTo(xOf(pts[0].dist_nm), yOf(pts[0].elev_ft));
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(xOf(pts[i].dist_nm), yOf(pts[i].elev_ft));
        }
        ctx.lineTo(xOf(pts[pts.length - 1].dist_nm), yOf(0));
        ctx.lineTo(xOf(pts[0].dist_nm), yOf(0));
        ctx.closePath();
        ctx.fillStyle   = 'rgba(139,90,43,0.85)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(80,50,20,0.9)';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
    }

    // ── Profile data builders ─────────────────────────────────────────────────

    _buildFlightPath(routeData, totalDist) {
        const depAlt  = routeData.depElevFt  || 0;
        const destAlt = routeData.destElevFt || 0;
        const crz     = routeData.cruiseAltFt || 10000;
        const pts     = [];

        if (!routeData.legs?.length) {
            // Simple trapezoidal profile
            pts.push({ dist: 0,               alt: depAlt,  phase: 'CLB' });
            pts.push({ dist: totalDist * 0.15, alt: crz,    phase: 'CRZ' });
            pts.push({ dist: totalDist * 0.85, alt: crz,    phase: 'CRZ' });
            pts.push({ dist: totalDist,        alt: destAlt, phase: 'DES' });
            return pts;
        }

        pts.push({ dist: 0, alt: depAlt, phase: 'CLB' });
        let cumDist = 0;

        for (const leg of routeData.legs) {
            const legDist = leg.dist || 0;
            const segs    = leg.segments || [];
            if (segs.length > 0) {
                let sd = cumDist;
                for (const seg of segs) {
                    const segLen = seg.dist_nm || (legDist / segs.length);
                    pts.push({ dist: sd,          alt: seg.altFrom ?? crz, phase: seg.phase || 'CRZ' });
                    pts.push({ dist: sd + segLen, alt: seg.altTo   ?? crz, phase: seg.phase || 'CRZ' });
                    sd += segLen;
                }
            } else {
                // No segment data — assume climb/cruise/descend split
                pts.push({ dist: cumDist + legDist * 0.3, alt: crz,  phase: 'CRZ' });
                pts.push({ dist: cumDist + legDist * 0.9, alt: crz,  phase: 'CRZ' });
            }
            cumDist += legDist;
        }

        const last = pts[pts.length - 1];
        if (last.dist < totalDist) {
            pts.push({ dist: totalDist, alt: destAlt, phase: 'DES' });
        }

        return pts;
    }

    // ── Interpolation helpers ─────────────────────────────────────────────────

    /** Linear interpolation in an array of {[xKey], [yKey]} objects sorted by xKey. */
    _interpValue(arr, x, xKey, yKey) {
        if (!arr.length) return null;
        if (x <= arr[0][xKey])                 return arr[0][yKey];
        if (x >= arr[arr.length - 1][xKey])    return arr[arr.length - 1][yKey];
        for (let i = 0; i < arr.length - 1; i++) {
            const a = arr[i], b = arr[i + 1];
            if (x >= a[xKey] && x <= b[xKey]) {
                const span = b[xKey] - a[xKey];
                if (span < 0.0001) return a[yKey];
                return a[yKey] + (x - a[xKey]) / span * (b[yKey] - a[yKey]);
            }
        }
        return null;
    }

    _interpTerrain(terrain, dist) {
        return this._interpValue(terrain, dist, 'dist_nm', 'elev_ft') ?? 0;
    }

    // ── Terrain profile from in-memory grid ──────────────────────────────────

    _fetchTerrainProfile(coords) {
        if (!coords || coords.length < 2) return [];
        // Use in-memory grid if available (fast, works offline)
        if (window.terrainGrid?.isLoaded) {
            return window.terrainGrid.buildProfile(coords, 1.0);
        }
        // Fall back to empty (grid not synced)
        return [];
    }
}
