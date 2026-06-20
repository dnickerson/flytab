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
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

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


def get_token() -> str:
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
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)

    _token        = data['access_token']
    _token_expiry = time.time() + int(data.get('expires_in', 1799)) - 60
    return _token


def fetch_notams(locations):
    token    = get_token()
    features = []
    for icao in locations:
        url = f'{CGI_BASE}/nmsapi/v1/notams?location={urllib.parse.quote(icao)}'
        req = urllib.request.Request(url, headers={
            'Authorization':     f'Bearer {token}',
            'nmsResponseFormat': 'GEOJSON',
        })
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.load(resp)
            features.extend(data.get('data', {}).get('geojson') or [])
        except urllib.error.HTTPError as e:
            print(f'[notam-proxy] {icao} → HTTP {e.code}')
        except Exception as e:
            print(f'[notam-proxy] {icao} → {e}')
    return features


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f'[notam-proxy] {self.address_string()} {fmt % args}')

    def _send_json(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.send_header('Content-Type',   'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control',  'public, max-age=300, stale-while-revalidate=60')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
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

        try:
            features = fetch_notams(locations)
            self._send_json(200, {'features': features, 'total': len(features)})
        except Exception as e:
            print(f'[notam-proxy] fetch error: {e}')
            self._send_json(502, {'error': str(e), 'features': []})


def main():
    ap = argparse.ArgumentParser(description='FlyTab NOTAM proxy')
    ap.add_argument('--port', type=int, default=8092)
    args = ap.parse_args()

    print(f'[notam-proxy] listening on :{args.port}')
    print(f'[notam-proxy] expose with: tailscale funnel {args.port}')
    HTTPServer(('', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
