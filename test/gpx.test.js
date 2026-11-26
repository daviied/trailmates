const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseGpx } = require('../server/gpx');

test('parses a GPX track', () => {
  const r = parseGpx(fs.readFileSync(path.join(__dirname, 'sample.gpx'), 'utf8'));
  assert.equal(r.name, 'Test Loop Trail');
  assert.ok(r.points.length > 100);
  assert.ok(r.distance > 3000 && r.distance < 6000, 'distance ' + r.distance);
  assert.ok(r.gain > 250 && r.gain < 320, 'gain ' + r.gain);
});
test('rejects non GPX', () => assert.throws(() => parseGpx('<html></html>')));
test('falls back to route points', () => {
  const r = parseGpx('<gpx><rte><rtept lon="1" lat="2"/><rtept lat="2.01" lon="1.01"/></rte></gpx>');
  assert.equal(r.points.length, 2);
});
