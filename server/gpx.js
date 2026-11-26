'use strict';
// Small GPX parser: track points (or route points), distance and elevation gain/loss.
const R = 6371000;
function hav(a, b) {
  const toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function readPoints(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, 'g');
  const pts = []; let m;
  while ((m = re.exec(xml))) {
    const lat = /\blat\s*=\s*["']([-\d.eE+]+)["']/.exec(m[1]);
    const lon = /\blon\s*=\s*["']([-\d.eE+]+)["']/.exec(m[1]);
    if (!lat || !lon) continue;
    const ele = m[2] && /<(?:\w+:)?ele>\s*([-\d.eE+]+)\s*</.exec(m[2]);
    pts.push([Number(lat[1]), Number(lon[1]), ele ? Number(ele[1]) : null]);
  }
  return pts.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

function parseGpx(xml) {
  if (!/<gpx[\s>]/i.test(xml)) throw new Error('This is not a GPX file');
  let pts = readPoints(xml, 'trkpt');
  if (pts.length < 2) pts = readPoints(xml, 'rtept');
  if (pts.length < 2) throw new Error('No trail found in this GPX file');
  const nameM = /<(?:\w+:)?name>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:\w+:)?name>/.exec(xml);

  // Drop points closer than 5 m, then cap the count to keep the phone fast.
  const out = [pts[0]];
  for (const p of pts) if (hav(out[out.length - 1], p) >= 5) out.push(p);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  let thin = out;
  if (out.length > 3000) { const step = out.length / 3000; thin = []; for (let i = 0; i < 3000; i++) thin.push(out[Math.floor(i * step)]); thin.push(out[out.length - 1]); }

  // Fill missing elevation from neighbours.
  let last = thin.find(p => p[2] != null)?.[2] ?? 0;
  for (const p of thin) { if (p[2] == null) p[2] = last; else last = p[2]; }

  let distance = 0, gain = 0, loss = 0, ref = thin[0][2];
  for (let i = 1; i < thin.length; i++) {
    distance += hav(thin[i - 1], thin[i]);
    const d = thin[i][2] - ref; // 3 m hysteresis removes GPS noise
    if (d > 3) { gain += d; ref = thin[i][2]; } else if (d < -3) { loss -= d; ref = thin[i][2]; }
  }
  const round = p => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6, Math.round(p[2] * 10) / 10];
  return { name: nameM ? nameM[1].replace(/<[^>]+>/g, '').trim() : '', points: thin.map(round), distance, gain, loss };
}

module.exports = { parseGpx, hav };
