"""
tools/notam-proxy.py GET /tfrs: TFRs from tfr.faa.gov with exact areas, altitudes
and times. Fixtures are the FAA's own files for 2026-10-29: 6/3091 (Charlotte /
Rock Hill VIP, six areas, 30 and 10 nm rings, KLKR inside the 30 nm rings) and
6/3503 (CLT UAS only, 2 nm). Run: python3 -m unittest tests/tools/test_notam_proxy_tfr.py
"""
import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FIX = os.path.join(ROOT, 'tests', 'fixtures', 'tfr')

spec = importlib.util.spec_from_file_location('notam_proxy', os.path.join(ROOT, 'tools', 'notam-proxy.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

KLKR = (34.722904, -80.854590)


def read(name):
    with open(os.path.join(FIX, name), 'rb') as f:
        return f.read()


def inside(pt, poly):
    y, x = pt
    c = False
    for i in range(len(poly)):
        y1, x1 = poly[i]
        y2, x2 = poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


class ParseDetail(unittest.TestCase):
    def test_charlotte_vip_areas_altitudes_and_times_in_utc(self):
        t = proxy.parse_tfr_detail(read('detail_6_3091.xml'))
        self.assertEqual(t['id'], '6/3091')
        self.assertEqual(t['type'], '91.141')
        self.assertEqual(t['timeZone'], 'EDT')
        self.assertEqual([a['name'] for a in t['areas']], ['Area A', 'Area B', 'Area C', 'Area D', 'Area E', 'Area F'])
        a = t['areas'][0]
        self.assertEqual((a['lowerFt'], a['lowerRef'], a['upperFt'], a['upperRef']), (0, 'AGL', 17999, 'MSL'))
        # 14:15-16:30 EDT local in the file
        self.assertEqual((a['start'], a['end']), ('2026-10-29T18:15:00Z', '2026-10-29T20:30:00Z'))
        self.assertEqual((t['start'], t['end']), ('2026-10-29T18:15:00Z', '2026-10-30T00:00:00Z'))
        self.assertIn('30NM RADIUS OF 351247N0805705W', t['text'])

    def test_klkr_is_inside_the_30_nm_rings_not_the_10_nm_ones(self):
        t = proxy.parse_tfr_detail(read('detail_6_3091.xml'))
        got = {a['name']: inside(KLKR, a['polygon']) for a in t['areas']}
        self.assertEqual(got, {'Area A': True, 'Area B': False, 'Area C': True, 'Area D': False,
                               'Area E': True, 'Area F': True})

    def test_uas_only_tfr_agl_ceiling(self):
        t = proxy.parse_tfr_detail(read('detail_6_3503.xml'))
        self.assertEqual(t['id'], '6/3503')
        a = t['areas'][0]
        self.assertEqual((a['lowerFt'], a['lowerRef'], a['upperFt'], a['upperRef']), (0, 'AGL', 2000, 'AGL'))
        self.assertEqual(a['start'], '2026-10-29T17:20:00Z')

    def test_xml_with_a_dtd_is_refused(self):
        with self.assertRaises(ValueError):
            proxy.parse_tfr_detail(b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')


class Helpers(unittest.TestCase):
    def test_to_utc(self):
        self.assertEqual(proxy._to_utc('2026-10-29T14:15:00', 'EDT', True), '2026-10-29T18:15:00Z')
        self.assertEqual(proxy._to_utc('2026-01-10T09:00:00', 'CST', True), '2026-01-10T15:00:00Z')
        self.assertEqual(proxy._to_utc('2026-10-29T14:15:00', 'UTC', False), '2026-10-29T14:15:00Z')
        self.assertIsNone(proxy._to_utc('2026-10-29T14:15:00', 'XYZ', True))   # unknown zone: no guessing
        self.assertIsNone(proxy._to_utc('soon', 'EDT', True))

    def test_alt(self):
        self.assertEqual(proxy._alt('HEI', '0', 'FT'), (0, 'AGL'))
        self.assertEqual(proxy._alt('ALT', '17999', 'FT'), (17999, 'MSL'))
        self.assertEqual(proxy._alt('STD', '180', 'FL'), (18000, 'FL'))
        self.assertEqual(proxy._alt('ALT', 'x', 'FT'), (None, None))

    def test_parse_bbox(self):
        self.assertEqual(proxy.parse_bbox('-83,33,-79,37'), (-83.0, 33.0, -79.0, 37.0))
        self.assertIsNone(proxy.parse_bbox(''))
        self.assertIsNone(proxy.parse_bbox('-79,33,-83,37'))        # W > E
        self.assertIsNone(proxy.parse_bbox('-120,20,-60,50'))       # 60 degrees: too big
        self.assertIsNone(proxy.parse_bbox('a,b,c,d'))


class FetchTfrs(unittest.TestCase):
    def setUp(self):
        self.calls = []
        files = {proxy.TFR_WFS_URL: read('wfs-subset.json'),
                 proxy.TFR_DETAIL_URL.format(key='6_3091'): read('detail_6_3091.xml'),
                 proxy.TFR_DETAIL_URL.format(key='6_3503'): read('detail_6_3503.xml')}

        def fake_get(url, ttl_s, timeout=20):
            self.calls.append(url)
            if url not in files:
                raise OSError('HTTP 404')
            return files[url]
        self._orig = proxy._tfr_get
        proxy._tfr_get = fake_get

    def tearDown(self):
        proxy._tfr_get = self._orig

    def test_box_around_klkr_gets_charlotte_with_details_not_orlando(self):
        r = proxy.fetch_tfrs((-82.0, 34.0, -80.0, 36.0))
        ids = [t['id'] for t in r['tfrs']]
        self.assertEqual(sorted(ids), ['6/3091', '6/3503'])
        self.assertEqual(r['failed'], [])
        clt = next(t for t in r['tfrs'] if t['id'] == '6/3091')
        self.assertTrue(clt['detail'])
        self.assertEqual(clt['legal'], 'VIP')
        self.assertEqual(len(clt['areas']), 6)
        self.assertNotIn(proxy.TFR_DETAIL_URL.format(key='4_3634'), self.calls)   # Disney, FL: not asked

    def test_detail_failure_still_draws_the_shape_and_says_so(self):
        r = proxy.fetch_tfrs((-82.5, 27.5, -80.5, 29.5))   # around Orlando: 4/3634 has no fixture -> 404
        t = r['tfrs'][0]
        self.assertEqual(t['id'], '4/3634')
        self.assertFalse(t['detail'])
        self.assertTrue(t['areas'] and len(t['areas'][0]['polygon']) >= 3)
        self.assertIsNone(t['areas'][0]['start'])
        self.assertEqual(r['failed'], ['4/3634'])


if __name__ == '__main__':
    unittest.main()
