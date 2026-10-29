#!/usr/bin/env python3
"""
NOTAM proxy for FitPC.

Proxies CGI Federal NMS-API NOTAM requests so the FlyTab app can reach
the staging API from a trusted IP without going through Vercel.

Usage:
    python3 notam-proxy.py [--port 8092]

Expose publicly via Tailscale Funnel:
    tailscale funnel 8092

Then set notamBase in web/cockpit-config.json to your Funnel URL,
e.g. "https://fitpc.tailnet-xxxx.ts.net"

Env vars (or edit CGI_KEY / CGI_SECRET below):
    CGI_NOTAM_API_KEY
    CGI_NOTAM_API_SECRET
"""

import argparse
import base64
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CGI_BASE   = 'https://api-staging.cgifederal-aim.com'
CGI_KEY    = os.environ.get('CGI_NOTAM_API_KEY',    'Zul4Ap9oAusAGINDA1naAQrXYBD4CDVromZ3dEUAv0C3XGxA')
CGI_SECRET = os.environ.get('CGI_NOTAM_API_SECRET', 'sFgZNLHqO6K3mZAAKjl6AVnZZfhDIVgg0YFxtOyX4Iyb5r9sqCP0S0QRmOZzc9U9')

CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
}

_token        = None
_token_expiry = 0


_token_lock   = threading.Lock()

# A request that asks for a deadline (?deadline=25 -- FlyTab's Restricted/MOA
# check, which reads `failed`) stops its FAA calls (token included) after it,
# at most this long; the locations not reached are listed as failed. Without
# one (WX Briefing) every location is asked, as before.
REQUEST_DEADLINE_S = 25
# The proxy is public (Tailscale Funnel) and spends the CGI account: at most
# this many requests call the FAA at once (others get 503), and this many
# locations per request (WX Briefing sends the route's airports, FlyTab's
# Restricted/MOA check 6 ARTCCs).
MAX_CONCURRENT     = 3
MAX_LOCATIONS      = 60
_busy              = threading.BoundedSemaphore(MAX_CONCURRENT)
# Requests allowed to wait for a slot; more get 503 at once, so a flood
# cannot pile up threads and sockets (review 13).
MAX_WAITING        = 10
_waiting           = threading.BoundedSemaphore(MAX_WAITING)


def drop_token(rejected):
    """After a 401: the next request gets a new token -- unless another
    request already got one since (only the rejected token is dropped)."""
    global _token, _token_expiry
    with _token_lock:
        if _token == rejected:
            _token, _token_expiry = None, 0


def get_token(deadline=None) -> str:
    with _token_lock:
        left = 15 if deadline is None else max(1, min(15, deadline - time.monotonic()))
        return _get_token(left)


def _get_token(timeout=15) -> str:
    global _token, _token_expiry
    if _token and time.time() < _token_expiry:
        return _token

    creds = base64.b64encode(f'{CGI_KEY}:{CGI_SECRET}'.encode()).decode()
    req = urllib.request.Request(
        f'{CGI_BASE}/v1/auth/token',
        data=b'grant_type=client_credentials',
        headers={
            'Authorization': f'Basic {creds}',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)

    _token        = data['access_token']
    _token_expiry = time.time() + int(data.get('expires_in', 1799)) - 60
    return _token


def fetch_notams(locations, deadline=None):
    """(features, failed): failed lists the locations the FAA did not answer,
    so a client can tell "no NOTAMs" from "not fetched" (FlyTab SuaNotams).
    deadline: time.monotonic() by which to stop; None: no overall limit."""
    token    = get_token(deadline)
    features = []
    failed   = []
    renewed  = False                 # the token was renewed once after a 401
    n        = 0
    while n < len(locations):
        icao = locations[n]
        left = 20 if deadline is None else deadline - time.monotonic()
        if left < 2:
            print(f'[notam-proxy] deadline: not asked {",".join(locations[n:])}')
            failed.extend(locations[n:])
            break
        url = f'{CGI_BASE}/nmsapi/v1/notams?location={urllib.parse.quote(icao)}'
        req = urllib.request.Request(url, headers={
            'Authorization':     f'Bearer {token}',
            'nmsResponseFormat': 'GEOJSON',
        })
        try:
            with urllib.request.urlopen(req, timeout=min(20, left)) as resp:
                data = json.load(resp)
            body = data.get('data') if isinstance(data, dict) else None
            if isinstance(body, dict):
                # data without a geojson list: taken as no NOTAMs (the API does
                # not require the list; a quiet VOR id or field must not fail WX
                # Briefing -- review 10). FlyTab's Restricted/MOA check never
                # counts an ARTCC with no NOTAMs as downloaded, so it stays safe.
                geo = body.get('geojson')
                features.extend(geo if isinstance(geo, list) else [])
            else:
                # No data object (the API requires one): not an answer.
                print(f'[notam-proxy] {icao} → no data in the answer')
                failed.append(icao)
        except urllib.error.HTTPError as e:
            print(f'[notam-proxy] {icao} → HTTP {e.code}')
            if e.code == 401 and not renewed:
                # The token was refused (expired early, revoked): a new one,
                # and this location again -- once (review 13).
                drop_token(token)
                renewed = True
                try:
                    token = get_token(deadline)
                    continue
                except Exception as te:
                    print(f'[notam-proxy] new token failed: {te}')
            failed.append(icao)
            if e.code == 401 or (deadline is not None and e.code in (403, 429)):
                # Refused again (401): every other location would be too. A
                # 403 (IP not allowed -- e.g. a VPN on the FitPC) or 429 (rate
                # limit) stops only a request with a deadline, whose client
                # reads `failed` and backs off; WX Briefing does not, so all
                # its stations are still asked, as before (review 12).
                if e.code == 401:
                    drop_token(token)
                failed.extend(locations[n + 1:])
                break
        except Exception as e:
            print(f'[notam-proxy] {icao} → {e}')
            failed.append(icao)
        n += 1
    return features, failed


# ---------------------------------------------------------------------------
# TFRs from tfr.faa.gov (GET /tfrs?bbox=W,S,E,N). The FAA's own TFR site: every
# TFR's exact areas (polygons, rings already drawn as points), altitudes and
# per-area times. The NMS staging API misses real TFRs (flytab #146) and its
# text has to be parsed; tfr.faa.gov sends no CORS header, so FlyTab gets it
# through here. Undocumented endpoints (the site's own front end): defensive.
# ---------------------------------------------------------------------------
TFR_BASE        = 'https://tfr.faa.gov'
TFR_WFS_URL     = (TFR_BASE + '/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature'
                   '&typeName=TFR:V_TFR_LOC&outputFormat=application/json&srsname=EPSG:4326')
TFR_DETAIL_URL  = TFR_BASE + '/download/detail_{key}.xml'      # key "6_3091"
TFR_WFS_TTL_S    = 300      # the FAA is asked at most this often for the shape list
TFR_DETAIL_TTL_S = 900      # and for one TFR's details
TFR_MAX_DETAILS  = 40       # TFRs per request with details (closest to the box centre first); the rest: shapes only
TFR_DEADLINE_S   = 45       # a /tfrs answer within this (FlyTab waits 60 s): details not fetched by then -> shapes only
TFR_MAX_BYTES    = 4_000_000
TFR_MAX_SPAN_DEG = 30
TFR_TEXT_MAX     = 6000
_tfr_cache = {}             # url -> (monotonic time, bytes)
_tfr_cache_lock = threading.Lock()
_tfr_busy = threading.BoundedSemaphore(2)
_tfr_waiting = threading.BoundedSemaphore(4)    # more than this waiting for a slot: 503 at once

# NOTAM time zones (codeTimeZone) -> UTC offset hours
TZ_OFFSETS = {'UTC': 0, 'GMT': 0, 'Z': 0, 'AST': -4, 'ADT': -3, 'EST': -5, 'EDT': -4, 'CST': -6,
              'CDT': -5, 'MST': -7, 'MDT': -6, 'PST': -8, 'PDT': -7, 'AKST': -9, 'AKDT': -8,
              'HST': -10, 'HDT': -9, 'SST': -11, 'CHST': 10}


def _tfr_get(url, ttl_s, timeout=20):
    """GET with a short cache, so FlyTab's 15-minute refreshes never hammer the FAA."""
    now = time.monotonic()
    with _tfr_cache_lock:
        hit = _tfr_cache.get(url)
        if hit and now - hit[0] < ttl_s:
            return hit[1]
    req = urllib.request.Request(url, headers={'User-Agent': 'FlyTab-NOTAM-proxy/1.0 (+FitPC)'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read(TFR_MAX_BYTES + 1)
    if len(data) > TFR_MAX_BYTES:
        raise ValueError('response too large')
    with _tfr_cache_lock:
        _tfr_cache[url] = (time.monotonic(), data)
        for k in [k for k, v in _tfr_cache.items() if time.monotonic() - v[0] > 3600]:
            _tfr_cache.pop(k, None)
    return data


def _tag(e):
    return e.tag.rsplit('}', 1)[-1]


def _child(e, name):
    if e is None:
        return None
    for c in e:
        if _tag(c) == name:
            return c
    return None


def _desc(e, name):
    if e is None:
        return None
    for c in e.iter():
        if _tag(c) == name:
            return c
    return None


def _text(e, name):
    c = _child(e, name)
    return c.text.strip() if c is not None and c.text else None


def _coord(v):
    """'35.21382579N' / '080.95138889W' -> signed float, else None."""
    if not v or v[-1] not in 'NSEW':
        return None
    try:
        x = float(v[:-1])
    except ValueError:
        return None
    return -x if v[-1] in 'SW' else x


def _to_utc(local, tz, is_local):
    """'2026-10-29T14:15:00' in the NOTAM's time zone -> '2026-10-29T18:15:00Z', or None."""
    if not local:
        return None
    try:
        t = datetime.strptime(local[:19], '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return None
    if is_local:
        off = TZ_OFFSETS.get((tz or '').upper())
        if off is None:
            return None
        t = t - timedelta(hours=off)
    return t.replace(tzinfo=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _alt(code, val, uom):
    """(ft or None, 'AGL' | 'MSL' | 'FL') from codeDistVer / valDistVer / uomDistVer."""
    try:
        v = float(val)
    except (TypeError, ValueError):
        return None, None
    ref = {'HEI': 'AGL', 'ALT': 'MSL', 'STD': 'FL'}.get((code or '').upper(), 'MSL')
    u = (uom or 'FT').upper()
    if u == 'FL':
        return v * 100, 'FL'
    if u == 'M':
        v = v * 3.28084
    return round(v), ref


def parse_tfr_detail(data):
    """tfr.faa.gov detail XML (bytes) -> TFR dict with its areas, or None."""
    # The whole document: a DTD after a long comment got past a 4 KB check (review 10-29).
    low = data.lower()
    if b'<!doctype' in low or b'<!entity' in low:
        raise ValueError('XML with a DTD refused')
    root = ET.fromstring(data)
    notam = _desc(root, 'Not')
    if notam is None:
        return None
    uid = _child(notam, 'NotUid')
    year, seq = _text(uid, 'dateIndexYear'), _text(uid, 'noSeqNo')
    tid = f'{year[-1]}/{seq}' if year and seq else None
    tz = _text(notam, 'codeTimeZone')
    tfr_not = _child(notam, 'TfrNot')
    areas = []
    for g in (tfr_not if tfr_not is not None else []):
        if _tag(g) != 'TFRAreaGroup':
            continue
        ase = _child(g, 'aseTFRArea')
        merged = _child(g, 'abdMergedArea')
        if ase is None or merged is None:
            continue
        pts = []
        for v in merged:
            if _tag(v) != 'Avx':
                continue
            lat, lon = _coord(_text(v, 'geoLat')), _coord(_text(v, 'geoLong'))
            if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
                pts.append([round(lat, 6), round(lon, 6)])
        if len(pts) < 3:
            continue
        is_local = (_text(g, 'codeLclTime') or '').upper() == 'TRUE'
        # Every schedule of the area: earliest start, latest end (an end not known
        # in any of them: not known -- never dropped early).
        starts, ends = [], []
        for sg in ase:
            if _tag(sg) != 'ScheduleGroup':
                continue
            starts.append(_to_utc(_text(sg, 'dateEffective'), tz, is_local))
            ends.append(_to_utc(_text(sg, 'dateExpire'), tz, is_local))
        lo_ft, lo_ref = _alt(_text(ase, 'codeDistVerLower'), _text(ase, 'valDistVerLower'), _text(ase, 'uomDistVerLower'))
        up_ft, up_ref = _alt(_text(ase, 'codeDistVerUpper'), _text(ase, 'valDistVerUpper'), _text(ase, 'uomDistVerUpper'))
        areas.append({
            'name': _text(ase, 'txtName') or '',
            'lowerFt': lo_ft, 'lowerRef': lo_ref, 'upperFt': up_ft, 'upperRef': up_ref,
            'start': min(starts) if starts and all(starts) else None,
            'end': max(ends) if ends and all(ends) else None,
            'polygon': pts,
        })
    text = _text(notam, 'txtDescrTraditional') or ''
    return {
        'id': tid,
        'type': _text(tfr_not, 'codeType') if tfr_not is not None else None,
        'name': _text(uid, 'txtLocalName') or '',
        'facility': _text(notam, 'codeFacility') or _text(uid, 'txtNameAcctFac'),
        'start': _to_utc(_text(notam, 'dateEffective'), tz, True),
        'end': _to_utc(_text(notam, 'dateExpire'), tz, True),
        'timeZone': tz,
        'areas': areas,
        'text': ' '.join(text.split())[:TFR_TEXT_MAX],
    }


def _inside(pt, poly):
    """[lat, lon] in a [[lat, lon], ...] ring."""
    y, x = pt
    c = False
    for i in range(len(poly)):
        y1, x1 = poly[i]
        y2, x2 = poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def _outer_rings(geom):
    """The outer ring(s) of a GeoJSON Polygon or MultiPolygon, else []."""
    t, c = geom.get('type'), geom.get('coordinates') or []
    if t == 'Polygon':
        return c[:1]
    if t == 'MultiPolygon':
        return [p[0] for p in c if p]
    return []


def _bbox_of(coords):
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return min(lons), min(lats), max(lons), max(lats)


def fetch_tfrs(bbox):
    """bbox (W, S, E, N) -> {'tfrs': [...], 'failed': [ids]}: every TFR whose
    shape reaches into the box, closest first, with its details."""
    w, s, e, n = bbox
    started = time.monotonic()
    fc = json.loads(_tfr_get(TFR_WFS_URL, TFR_WFS_TTL_S))
    features = fc.get('features') or []
    # There are always TFRs somewhere (the permanent ones): none at all is the
    # FAA's service or its format failing, not "no TFRs" -- FlyTab would hide
    # the NOTAM-text TFRs on that answer (review 10-29).
    if not features:
        raise ValueError('tfr.faa.gov listed no TFRs at all')
    by_id, unread = {}, set()
    for f in features:
        props = f.get('properties') or {}
        geom = f.get('geometry') or {}
        key = str(props.get('NOTAM_KEY') or '').split('-')[0]
        rings = [r for r in _outer_rings(geom) if len(r) >= 3]
        if not rings:
            unread.add(key or '?')
            continue
        for ring in rings:
            fw, fs, fe, fn = _bbox_of(ring)
            if fe < w or fw > e or fn < s or fs > n:
                continue
            t = by_id.setdefault(key, {'id': key, 'title': props.get('TITLE') or '', 'state': props.get('STATE'),
                                       'facility': props.get('CNS_LOCATION_ID'), 'legal': props.get('LEGAL'),
                                       'modified': props.get('LAST_MODIFICATION_DATETIME'), 'shapes': []})
            t['shapes'].append([[round(lat, 6), round(lon, 6)] for lon, lat in ring])
    if unread:
        print(f'[notam-proxy] TFR shapes not read (geometry): {" ".join(sorted(unread))}')
    cx, cy = (w + e) / 2, (s + n) / 2
    def dist(t):
        pts = [p for sh in t['shapes'] for p in sh]
        return min((p[0] - cy) ** 2 + (p[1] - cx) ** 2 for p in pts)
    ids = sorted(by_id, key=lambda k: dist(by_id[k]))
    detailed = set(ids[:TFR_MAX_DETAILS])      # the rest: drawn from their shapes (review 10-29)

    def shapes_only(shapes):
        return [{'name': '', 'lowerFt': None, 'lowerRef': None, 'upperFt': None, 'upperRef': None,
                 'start': None, 'end': None, 'polygon': sh} for sh in shapes]

    def one(key):
        base = by_id[key]
        out = {k: base[k] for k in ('id', 'title', 'state', 'facility', 'legal', 'modified')}
        d = None
        left = TFR_DEADLINE_S - (time.monotonic() - started)
        if key in detailed and left > 2:
            try:
                d = parse_tfr_detail(_tfr_get(TFR_DETAIL_URL.format(key=key.replace('/', '_')), TFR_DETAIL_TTL_S,
                                              timeout=min(20, left)))
            except Exception as ex:
                print(f'[notam-proxy] TFR {key} detail failed: {ex}')
        if d and d.get('areas'):
            # A shape the details left out (no merged area, or too few points) is
            # still drawn, from the FAA's shape list.
            extra = [sh for sh in base['shapes']
                     if not any(_inside([sum(p[0] for p in sh) / len(sh), sum(p[1] for p in sh) / len(sh)], a['polygon'])
                                for a in d['areas'])]
            out.update({'type': d['type'], 'name': d['name'], 'start': d['start'], 'end': d['end'],
                        'timeZone': d['timeZone'], 'areas': d['areas'] + shapes_only(extra), 'text': d['text'],
                        'detail': True})
            return out, False
        # No details: the shapes alone, with no altitudes or times (still drawn)
        out.update({'areas': shapes_only(base['shapes']), 'detail': False})
        return out, True

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(one, ids))
    return {'tfrs': [r for r, _ in results], 'failed': [r['id'] for r, bad in results if bad] + sorted(unread)}


def parse_bbox(v):
    """'W,S,E,N' -> tuple of floats, or None if missing or unreasonable."""
    try:
        w, s, e, n = (float(x) for x in (v or '').split(','))
    except ValueError:
        return None
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        return None
    if e - w > TFR_MAX_SPAN_DEG or n - s > TFR_MAX_SPAN_DEG:
        return None
    return w, s, e, n


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f'[notam-proxy] {self.address_string()} {fmt % args}')

    timeout = 30        # an idle connection does not hold a thread

    def _send_json(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.send_header('Content-Type',   'application/json')
        self.send_header('Content-Length', str(len(data)))
        # A complete answer may be cached; an error or a partial one must not
        # come back from a cache when the client retries.
        complete = status == 200 and not body.get('failed')
        self.send_header('Cache-Control',  'public, max-age=300, stale-while-revalidate=60' if complete else 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        arrived = time.monotonic()
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/tfrs':
            self._get_tfrs(parsed)
            return
        if parsed.path != '/notams':
            self._send_json(404, {'error': 'Not found'})
            return

        params    = urllib.parse.parse_qs(parsed.query)
        loc_param = params.get('location', [''])[0]
        locations = [s.strip().upper() for s in loc_param.split(',') if s.strip()]

        if not locations:
            self._send_json(400, {'error': 'location parameter required'})
            return
        if len(locations) > MAX_LOCATIONS:
            self._send_json(400, {'error': f'at most {MAX_LOCATIONS} locations per request'})
            return
        # The deadline runs from arrival, so a wait for a free slot counts.
        deadline = None
        try:
            want = float(params.get('deadline', [''])[0] or 0)
        except ValueError:
            want = 0
        if want > 0:
            deadline = arrived + min(want, REQUEST_DEADLINE_S)
        # A request without a deadline (WX Briefing) waits for a slot as the
        # single-threaded proxy used to queue it; one with a deadline gives up
        # sooner -- its client retries (review 12).
        if not _waiting.acquire(blocking=False):
            self._send_json(503, {'error': 'busy, try again', 'features': []})
            return
        try:
            got_slot = _busy.acquire(timeout=5 if deadline is not None else 25)
        finally:
            _waiting.release()
        if not got_slot:
            self._send_json(503, {'error': 'busy, try again', 'features': []})
            return
        try:
            features, failed = fetch_notams(locations, deadline)
            self._send_json(200, {'features': features, 'total': len(features), 'failed': failed})
        except Exception as e:
            print(f'[notam-proxy] fetch error: {e}')
            self._send_json(502, {'error': str(e), 'features': []})
        finally:
            _busy.release()


def _handler_get_tfrs(self, parsed):
    bbox = parse_bbox(urllib.parse.parse_qs(parsed.query).get('bbox', [''])[0])
    if bbox is None:
        self._send_json(400, {'error': f'bbox=W,S,E,N required (at most {TFR_MAX_SPAN_DEG} degrees each way)', 'tfrs': []})
        return
    # Public (Funnel): a few may wait for a slot, the rest are turned away at once.
    if not _tfr_waiting.acquire(blocking=False):
        self._send_json(503, {'error': 'busy, try again', 'tfrs': []})
        return
    try:
        got_slot = _tfr_busy.acquire(timeout=10)
    finally:
        _tfr_waiting.release()
    if not got_slot:
        self._send_json(503, {'error': 'busy, try again', 'tfrs': []})
        return
    try:
        body = fetch_tfrs(bbox)
        body['source'] = 'tfr.faa.gov'
        body['fetchedAt'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self._send_json(200, body)
    except Exception as e:
        print(f'[notam-proxy] TFR fetch error: {e}')        # the detail stays here, not in the public answer
        self._send_json(502, {'error': 'tfr.faa.gov could not be read', 'tfrs': []})
    finally:
        _tfr_busy.release()


Handler._get_tfrs = _handler_get_tfrs


def main():
    ap = argparse.ArgumentParser(description='FlyTab NOTAM proxy')
    ap.add_argument('--port', type=int, default=8092)
    args = ap.parse_args()

    print(f'[notam-proxy] listening on :{args.port}')
    print(f'[notam-proxy] expose with: tailscale funnel {args.port}')
    # Threads: WX Briefing's request is not queued behind a slow SUA one.
    server = ThreadingHTTPServer(('', args.port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main()
