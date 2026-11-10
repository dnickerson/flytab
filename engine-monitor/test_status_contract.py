"""
Status payload contract for FlyTab (PI_API_CONTRACT 3): the Pi no longer runs
its own fuel tracker. Fuel is tracked on the tablet; the Pi only forwards the
Dynon D-180 EMS fuel fields it parses from the serial line.

Stdlib unittest only. From the repo root:
    python3 -m unittest discover -s engine-monitor -p "test_*.py"
"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine_monitor as em

# A real D-180 EMS serial line, copied verbatim from the capture
# ~/engine_analysis/stream_2325.txt (first line with RPM > 1000 and fuel data).
# Not in this repo: the raw captures live in ~/engine_analysis.
REAL_EMS_LINE = ('2003554609651050660521400071010200357119120CRB00071TRE-0021'
                 'GPT-0046-1121008099610001009058000742682582692653209991103EA')


class StatusContractTests(unittest.TestCase):
    def test_status_has_no_fuel_block(self):
        self.assertNotIn('fuel', em.get_status())

    def test_contract_is_3(self):
        self.assertEqual(em.PI_API_CONTRACT, 3)
        self.assertEqual(em.get_status()['api_contract'], 3)

    def test_capabilities_drop_fuel_tracker(self):
        self.assertEqual(em.PI_CAPABILITIES, ['peak_egt', 'gps_fix_quality'])
        self.assertEqual(em.get_status()['capabilities'], ['peak_egt', 'gps_fix_quality'])

    def test_dynon_fuel_fields_still_parsed(self):
        parsed = em.parse_line(REAL_EMS_LINE)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed['RPM'], 1010)
        self.assertAlmostEqual(parsed['Fuel_Flow'], 2.0)
        self.assertAlmostEqual(parsed['Fuel_Remaining'], 35.7)
        self.assertAlmostEqual(parsed['Fuel_Left'], 11.9)
        self.assertAlmostEqual(parsed['Fuel_Right'], 12.0)


class FuelEndpointsGoneTests(unittest.TestCase):
    """Drives the real RequestHandler on an ephemeral localhost port."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), em.RequestHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _status(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data,
                                     method='POST' if data is not None else 'GET')
        if data is not None:
            req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status
        except urllib.error.HTTPError as e:
            return e.code

    def test_fuel_endpoints_gone(self):
        self.assertEqual(self._status('/api/fuel'), 404)
        self.assertEqual(self._status('/api/fuel/set', {'fuel_remaining': 20}), 404)

    def test_status_endpoint_still_served(self):
        # Control: the handler itself works, so the 404s above are real.
        self.assertEqual(self._status('/api/status'), 200)


if __name__ == '__main__':
    unittest.main()
