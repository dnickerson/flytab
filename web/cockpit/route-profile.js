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
        this._scrubX          = null;
        this._scrubTouchY     = null;
        this._scrubAutoExpanded = false;

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

        // If terrain grid is still loading, re-render once it finishes
        if ((!routeData.terrainProfile || routeData.terrainProfile.length === 0)
                && window.terrainGrid && !window.terrainGrid.isLoaded) {
            this._terrainReadyHandler = () => {
                routeData.terrainProfile = this._fetchTerrainProfile(routeData.coords);
                this._render(this._routeData);
            };
            window.addEventListener('terrainGridLoaded', this._terrainReadyHandler, { once: true });
        }
    }

    hide() {
        this._el.style.display = 'none';
        this._visible = false;
        if (this._terrainReadyHandler) {
            window.removeEventListener('terrainGridLoaded', this._terrainReadyHandler);
            this._terrainReadyHandler = null;
        }
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
            position:  'relative',
            zIndex:    '1',
        });

        // Touch scrubber
        this._canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            // Auto-expand to full height when scrubbing starts
            if (!this._expanded) {
                this._scrubAutoExpanded = true;
                this._el.style.height = '280px';
                this._chevronBtn.textContent = '\u25BC';
            }
            this._updateScrub(e);
        }, { passive: false });
        this._canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            this._updateScrub(e);
        }, { passive: false });
        this._canvas.addEventListener('touchend', () => {
            // Collapse back if we auto-expanded
            if (this._scrubAutoExpanded) {
                this._scrubAutoExpanded = false;
                this._el.style.height = '180px';
                this._chevronBtn.textContent = '\u25B2';
            }
            this._scrubX      = null;
            this._scrubTouchY = null;
            if (this._routeData) this._render(this._routeData);
        });

        // Tooltip
        // Fixed right-side scrubber info panel
        this._tooltip = document.createElement('div');
        Object.assign(this._tooltip.style, {
            position:      'absolute',
            top:           '0',
            right:         '0',
            width:         '130px',
            height:        '100%',
            background:    '#0d0f1e',
            borderLeft:    '2px solid #00aaff',
            borderRadius:  '0 0 10px 0',
            padding:       '10px 10px',
            fontSize:      '13px',
            lineHeight:    '1.6',
            color:         'var(--text-primary)',
            pointerEvents: 'none',
            display:       'none',
            zIndex:        '2',
            overflowY:     'auto',
            boxSizing:     'border-box',
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
        this._scrubX      = e.touches[0].clientX - rect.left;
        this._scrubTouchY = e.touches[0].clientY - rect.top;
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

        const panelOpen = this._scrubX !== null;
        const pad = { top: 14, right: panelOpen ? 144 : 12, bottom: 52, left: 52 };
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
                ctx.font = 'bold 12px sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText('FZL', pad.left + 4, fy - 4);
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
            ctx.font      = 'bold 13px sans-serif';
            ctx.fillStyle = '#ef4444';
            ctx.textAlign = 'right';
            ctx.fillText(hasCritical ? '\u26A0 TERRAIN CONFLICT' : '\u26A0 TERRAIN',
                         pad.left + cw, pad.top + 16);
            ctx.restore();
        }

        // 8. Y-axis altitude labels ──────────────────────────────────────────
        ctx.fillStyle  = 'rgba(200,210,220,0.95)';
        ctx.font       = 'bold 12px sans-serif';
        ctx.textAlign  = 'right';
        const altStep  = yMax > 20000 ? 4000 : 2000;
        let lastAltLabelY = Infinity;
        for (let alt = 0; alt <= yMax; alt += altStep) {
            const y = yOf(alt);
            if (y < pad.top - 2 || y > h - pad.bottom + 6) continue;
            if (Math.abs(y - lastAltLabelY) < 16) continue; // skip if too close to previous
            lastAltLabelY = y;
            ctx.fillText(alt === 0 ? '0' : (alt / 1000).toFixed(0) + 'k', pad.left - 4, y + 4);
        }

        // 9. Waypoint tick marks and labels ──────────────────────────────────
        if (routeData.legs?.length) {
            ctx.strokeStyle = 'rgba(100,116,139,0.45)';
            ctx.lineWidth   = 1;
            ctx.font        = 'bold 12px sans-serif';
            ctx.textAlign   = 'center';
            let cumDist = 0;
            const wpPositions = [];
            for (const leg of routeData.legs) {
                wpPositions.push({ x: xOf(cumDist), label: leg.from });
                cumDist += (leg.dist || 0);
            }
            const last = routeData.legs[routeData.legs.length - 1];
            if (last?.to) wpPositions.push({ x: xOf(totalDist), label: last.to });

            // Draw tick lines
            for (const wp of wpPositions) {
                ctx.beginPath();
                ctx.moveTo(wp.x, pad.top);
                ctx.lineTo(wp.x, h - pad.bottom + 4);
                ctx.stroke();
            }

            // Draw labels — stagger alternating up/down to avoid overlap
            const fuelStopIds = new Set((routeData.fuelStops || []).map(fs => fs.icao));
            for (let i = 0; i < wpPositions.length; i++) {
                const wp = wpPositions[i];
                if (!wp.label) continue;
                if (fuelStopIds.has(wp.label)) continue; // labeled by fuel stop section instead
                const stagger = (i % 2 === 0) ? 0 : 14; // alternate row offset
                const yBase = h - pad.bottom + 14 + stagger;
                // Background pill for readability
                const tw = ctx.measureText(wp.label).width;
                ctx.fillStyle = 'rgba(15,15,30,0.65)';
                ctx.fillRect(wp.x - tw / 2 - 2, yBase - 11, tw + 4, 13);
                ctx.fillStyle = 'rgba(220,230,245,0.95)';
                ctx.fillText(wp.label, wp.x, yBase);
            }
        }

        // 9b. Altitude crossing constraint symbols ───────────────────────────
        if (routeData.waypointConstraints?.length) {
            this._drawAltConstraints(ctx, routeData.waypointConstraints, xOf, yOf, pad, ch);
        }

        // 9c. Fuel stop markers — vertical lines at each inter-Flight boundary
        if (routeData.fuelStops?.length) {
            ctx.save();
            ctx.strokeStyle = 'rgba(251,191,36,0.75)'; // amber
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.font        = 'bold 11px sans-serif';
            ctx.textAlign   = 'center';
            for (const fs of routeData.fuelStops) {
                const fx = xOf(fs.dist);
                ctx.beginPath();
                ctx.moveTo(fx, pad.top);
                ctx.lineTo(fx, h - pad.bottom + 4);
                ctx.stroke();
                // Label: ⛽ ICAO just below the x-axis
                ctx.setLineDash([]);
                ctx.fillStyle = 'rgba(251,191,36,0.9)';
                ctx.fillText('\u26FD\u2009' + fs.icao, fx, h - pad.bottom + 32);
                ctx.setLineDash([4, 3]);
            }
            ctx.restore();
        }

        // 10. Distance labels along x-axis ───────────────────────────────────
        ctx.fillStyle = 'rgba(150,165,180,0.85)';
        ctx.font      = '11px sans-serif';
        ctx.textAlign = 'center';
        const distStep = Math.max(10, Math.ceil(totalDist / 5 / 10) * 10);
        for (let d = distStep; d < totalDist - distStep * 0.4; d += distStep) {
            ctx.fillText(d.toFixed(0) + 'nm', xOf(d), h - 4);
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

                // All airspace bands that span this x position (regardless of flight alt)
                const allBandsHere = (routeData.airspaceBands || []).filter(
                    b => dist >= b.distFrom && dist <= b.distTo
                );
                if (routeData.airspaceBands?.length) {
                    console.log('[Profile] scrub dist:', dist.toFixed(1), 'bands:', routeData.airspaceBands.map(b => `${b.class} ${b.distFrom.toFixed(1)}-${b.distTo.toFixed(1)}`), 'hits:', allBandsHere.length);
                }

                // Build vertical info panel HTML
                const fmtAlt = (ft) => ft >= 1000 ? (ft / 1000).toFixed(1) + 'k' : ft + 'ft';
                const fmtFloor = (ft) => ft === 0 ? 'SFC' : fmtAlt(ft);
                const bandColors = { B: '#4499ff', C: '#cc44cc', D: '#4477cc' };

                let clearColor = '#4caf50';
                let clearIcon  = '✓';
                if (clearance < 0)    { clearColor = '#ef4444'; clearIcon = '⛰ CONFLICT'; }
                else if (clearance < 500)  { clearColor = '#ff5722'; clearIcon = '⚠'; }
                else if (clearance < 1000) { clearColor = '#ff9800'; clearIcon = '⚠'; }

                let html = `
                    <div style="color:#aab;font-size:11px;margin-bottom:4px">${dist.toFixed(0)} nm</div>
                    <div style="margin-bottom:6px">
                        <div style="color:#9ca3af;font-size:11px">FLIGHT</div>
                        <div style="font-size:15px;font-weight:700;color:#e0e8ff">${fmtAlt(Math.round(flightAlt))}</div>
                    </div>
                    <div style="margin-bottom:6px">
                        <div style="color:#9ca3af;font-size:11px">TERRAIN</div>
                        <div style="font-size:15px;font-weight:700;color:#c8a87a">${fmtAlt(Math.round(terrainElev))}</div>
                    </div>
                    <div style="margin-bottom:8px">
                        <div style="color:#9ca3af;font-size:11px">CLEAR</div>
                        <div style="font-size:15px;font-weight:700;color:${clearColor}">${clearIcon} ${fmtAlt(Math.round(Math.abs(clearance)))}</div>
                    </div>`;

                if (allBandsHere.length > 0) {
                    html += `<div style="border-top:1px solid #333;padding-top:6px;margin-top:2px">`;
                    html += `<div style="color:#9ca3af;font-size:11px;margin-bottom:4px">AIRSPACE</div>`;
                    for (const b of allBandsHere) {
                        const bc = bandColors[b.class] || '#8888cc';
                        html += `<div style="margin-bottom:5px">
                            <span style="font-size:13px;font-weight:700;color:${bc}">Class ${b.class}</span><br>
                            <span style="font-size:12px;color:#ccd">▲ ${b.upperFt >= 18000 ? 'FL180' : fmtAlt(b.upperFt)}</span><br>
                            <span style="font-size:12px;color:#ccd">▼ ${fmtFloor(b.lowerFt)}</span>
                        </div>`;
                    }
                    html += `</div>`;
                }

                this._tooltip.innerHTML = html;
                this._tooltip.style.display = 'block';
                console.log('[Profile] panel visible, offsetWidth:', this._tooltip.offsetWidth, 'offsetHeight:', this._tooltip.offsetHeight, 'zIndex:', this._tooltip.style.zIndex);
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

            // No inline labels — airspace details shown in scrubber panel on touch
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

    // ── Altitude crossing constraint symbols ──────────────────────────────────

    _drawAltConstraints(ctx, constraints, xOf, yOf, pad, ch) {
        const CYAN = '#00aaff';
        const barHW  = 16;   // half-width of horizontal bar in px
        const tickH  = 8;    // tick mark height for AT constraint
        const arrowSz = 6;   // arrow triangle size

        for (const wc of constraints) {
            if (!wc.alt) continue;
            const x = xOf(wc.dist);
            const y = yOf(wc.alt);

            // Vertical dashed guide line at waypoint x position
            ctx.save();
            ctx.strokeStyle = 'rgba(0,170,255,0.3)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 4]);
            ctx.beginPath();
            ctx.moveTo(x, pad.top);
            ctx.lineTo(x, pad.top + ch);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();

            if (wc.constraint === 'BETWEEN' && wc.altUpper) {
                const yUpper = yOf(wc.altUpper);
                // Shaded zone between floor and ceiling
                ctx.save();
                ctx.fillStyle = 'rgba(0,170,255,0.12)';
                ctx.fillRect(x - barHW, yUpper, barHW * 2, y - yUpper);
                ctx.restore();
                // Floor bar (AT OR ABOVE style)
                this._drawAltBar(ctx, x, y,      barHW, tickH, CYAN, 'none');
                // Ceiling bar (AT OR BELOW style)
                this._drawAltBar(ctx, x, yUpper, barHW, tickH, CYAN, 'none');
            } else {
                const arrowDir = wc.constraint === 'AT_OR_ABOVE' ? 'up'
                               : wc.constraint === 'AT_OR_BELOW' ? 'down'
                               : 'none';
                this._drawAltBar(ctx, x, y, barHW, tickH, CYAN, arrowDir, arrowSz);
            }
        }
    }

    _drawAltBar(ctx, cx, cy, barHW, tickH, color, arrowDir, arrowSz = 6) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle   = color;
        ctx.lineWidth   = 2;
        ctx.lineCap     = 'round';

        // Horizontal bar
        ctx.beginPath();
        ctx.moveTo(cx - barHW, cy);
        ctx.lineTo(cx + barHW, cy);
        ctx.stroke();

        if (arrowDir === 'none') {
            // Tick marks at ends (AT / BETWEEN boundary)
            ctx.beginPath();
            ctx.moveTo(cx - barHW, cy - tickH / 2);
            ctx.lineTo(cx - barHW, cy + tickH / 2);
            ctx.moveTo(cx + barHW, cy - tickH / 2);
            ctx.lineTo(cx + barHW, cy + tickH / 2);
            ctx.stroke();
        } else {
            // Filled arrow triangles at ends (AT OR ABOVE / AT OR BELOW)
            const dir = arrowDir === 'up' ? -1 : 1;
            // Left arrow
            ctx.beginPath();
            ctx.moveTo(cx - barHW,               cy);
            ctx.lineTo(cx - barHW - arrowSz / 2, cy + dir * arrowSz);
            ctx.lineTo(cx - barHW + arrowSz / 2, cy + dir * arrowSz);
            ctx.closePath();
            ctx.fill();
            // Right arrow
            ctx.beginPath();
            ctx.moveTo(cx + barHW,               cy);
            ctx.lineTo(cx + barHW - arrowSz / 2, cy + dir * arrowSz);
            ctx.lineTo(cx + barHW + arrowSz / 2, cy + dir * arrowSz);
            ctx.closePath();
            ctx.fill();
        }

        ctx.restore();
    }
}
