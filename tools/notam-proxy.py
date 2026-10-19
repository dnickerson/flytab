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
    for n, icao in enumerate(locations):
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
            if not isinstance(body, dict):
                # No data object (the API requires one): not an answer.
                print(f'[notam-proxy] {icao} → no data in the answer')
                failed.append(icao)
                continue
            # data without a geojson list: taken as no NOTAMs (the API does not
            # require the list; a quiet VOR id or field must not fail WX
            # Briefing -- review 10). FlyTab's Restricted/MOA check never
            # counts an ARTCC with no NOTAMs as downloaded, so it stays safe.
            geo = body.get('geojson')
            features.extend(geo if isinstance(geo, list) else [])
        except urllib.error.HTTPError as e:
            print(f'[notam-proxy] {icao} → HTTP {e.code}')
            failed.append(icao)
            if e.code == 401 or (deadline is not None and e.code in (403, 429)):
                # Refused token (401): every other location would be too. A
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
    return features, failed


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
        if not _busy.acquire(timeout=5 if deadline is not None else 25):
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
