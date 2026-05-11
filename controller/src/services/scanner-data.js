/* Offline scanner database.

   Four datasets, all embedded — no network calls at runtime:

     UNIVERSAL    Nationwide frequencies that don't change by location:
                  NOAA Weather Radio (7 channels), Aviation common AM,
                  Marine VHF, ham simplex calling, FRS/GMRS.

     ZIP3         3-digit ZIP prefix → { lat, lon, place }. A small seed set
                  covering major US metros — used to put a place name on the
                  user's ZIP. Unmapped ZIPs fall back to the geographic
                  centre of the contiguous US.

     REGIONAL     Future home for region-specific stations (towered airport
                  tower/ground/ATIS, NOAA NWR transmitter coverage maps, ham
                  repeaters by lat/lon). Each entry has a centre + radius
                  and a list of stations; runtime filters by user's lat/lon.

     PUBSAFETY    FCC ULS-derived analog public-safety frequencies, indexed
                  by 3-digit ZIP prefix. Built from the weekly l_LMpriv dump
                  (filtered to service code PW + analog F3E emission + VHF/
                  UHF voice bands). Built once into a .gz file so the 17 MB
                  raw JSON ships as 1.6 MB embedded; decompressed on first
                  lookup and cached.

   Frequency units throughout: integer Hz. Modulation: 'am' | 'wbfm' | 'nbfm'. */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const UNIVERSAL = [
  // ── NOAA Weather Radio ────────────────────────────────────────────────
  // Only one of these 7 will be active at any given location, but you can
  // tune any of them to find which is the local transmitter. NBFM, ~5 kHz
  // deviation, voice + tone alerts.
  { hz: 162400000, mod: 'nbfm', label: 'NOAA Weather (162.400)', cat: 'Weather' },
  { hz: 162425000, mod: 'nbfm', label: 'NOAA Weather (162.425)', cat: 'Weather' },
  { hz: 162450000, mod: 'nbfm', label: 'NOAA Weather (162.450)', cat: 'Weather' },
  { hz: 162475000, mod: 'nbfm', label: 'NOAA Weather (162.475)', cat: 'Weather' },
  { hz: 162500000, mod: 'nbfm', label: 'NOAA Weather (162.500)', cat: 'Weather' },
  { hz: 162525000, mod: 'nbfm', label: 'NOAA Weather (162.525)', cat: 'Weather' },
  { hz: 162550000, mod: 'nbfm', label: 'NOAA Weather (162.550)', cat: 'Weather' },

  // ── Aviation (AM, 25 kHz channel spacing on the 118–137 MHz band) ─────
  { hz: 121500000, mod: 'am', label: 'Aviation Emergency (Guard)',  cat: 'Aviation' },
  { hz: 122700000, mod: 'am', label: 'UNICOM (small airports)',     cat: 'Aviation' },
  { hz: 122800000, mod: 'am', label: 'UNICOM',                      cat: 'Aviation' },
  { hz: 122900000, mod: 'am', label: 'CTAF / Multicom',             cat: 'Aviation' },
  { hz: 122950000, mod: 'am', label: 'UNICOM (towered airports)',   cat: 'Aviation' },
  { hz: 123000000, mod: 'am', label: 'Flight Schools / FBO',        cat: 'Aviation' },
  { hz: 123450000, mod: 'am', label: 'Air-to-Air Common',           cat: 'Aviation' },
  { hz: 122100000, mod: 'am', label: 'Flight Service Station (RX)', cat: 'Aviation' },

  // ── Marine VHF (NBFM, 25 kHz channels on 156–162 MHz band) ────────────
  { hz: 156800000, mod: 'nbfm', label: 'Marine Ch 16 (Distress / Calling)', cat: 'Marine' },
  { hz: 156450000, mod: 'nbfm', label: 'Marine Ch 09 (Hailing)',            cat: 'Marine' },
  { hz: 156650000, mod: 'nbfm', label: 'Marine Ch 13 (Bridge / Lock)',      cat: 'Marine' },
  { hz: 156250000, mod: 'nbfm', label: 'Marine Ch 05A (Port Operations)',   cat: 'Marine' },
  { hz: 157100000, mod: 'nbfm', label: 'Marine Ch 22A (Coast Guard)',       cat: 'Marine' },

  // ── Amateur radio simplex calling frequencies ─────────────────────────
  // Listening only — transmitting on these frequencies requires an FCC
  // amateur licence in the US.
  { hz: 146520000, mod: 'nbfm', label: 'Ham 2m Simplex Calling',  cat: 'Amateur' },
  { hz: 446000000, mod: 'nbfm', label: 'Ham 70cm Simplex Calling', cat: 'Amateur' },
  { hz: 144200000, mod: 'nbfm', label: 'Ham 2m SSB Calling (USB)', cat: 'Amateur' },

  // ── FRS / GMRS (the Walmart walkie-talkie band — often busy) ──────────
  { hz: 462562500, mod: 'nbfm', label: 'FRS/GMRS Ch 1',  cat: 'Two-way' },
  { hz: 462587500, mod: 'nbfm', label: 'FRS/GMRS Ch 2',  cat: 'Two-way' },
  { hz: 462612500, mod: 'nbfm', label: 'FRS/GMRS Ch 3',  cat: 'Two-way' },
  { hz: 462637500, mod: 'nbfm', label: 'FRS/GMRS Ch 4',  cat: 'Two-way' },
  { hz: 462662500, mod: 'nbfm', label: 'FRS/GMRS Ch 5',  cat: 'Two-way' },
  { hz: 462687500, mod: 'nbfm', label: 'FRS/GMRS Ch 6',  cat: 'Two-way' },
  { hz: 462712500, mod: 'nbfm', label: 'FRS/GMRS Ch 7',  cat: 'Two-way' },
];

// 3-digit ZIP prefix → metro centre. Curated seed set covering top US metros
// by population. Coverage isn't comprehensive — anything not in this map
// falls back to USA_CENTER and the universal list is still useful.
//
// Sources: USPS ZCTA tabulation areas + Wikipedia "List of ZIP code prefixes",
// hand-spot-checked against major-metro central post offices.
const ZIP3 = {
  // Northeast
  '100': { lat: 40.7128, lon: -74.0060, place: 'New York, NY' },
  '101': { lat: 40.7128, lon: -74.0060, place: 'New York, NY' },
  '102': { lat: 40.7128, lon: -74.0060, place: 'New York, NY' },
  '103': { lat: 40.6437, lon: -74.0764, place: 'Staten Island, NY' },
  '104': { lat: 40.8448, lon: -73.8648, place: 'Bronx, NY' },
  '110': { lat: 40.7282, lon: -73.7949, place: 'Queens, NY' },
  '112': { lat: 40.6782, lon: -73.9442, place: 'Brooklyn, NY' },
  '021': { lat: 42.3601, lon: -71.0589, place: 'Boston, MA' },
  '022': { lat: 42.3601, lon: -71.0589, place: 'Boston, MA' },
  '191': { lat: 39.9526, lon: -75.1652, place: 'Philadelphia, PA' },
  '152': { lat: 40.4406, lon: -79.9959, place: 'Pittsburgh, PA' },
  '202': { lat: 38.9072, lon: -77.0369, place: 'Washington, DC' },
  '212': { lat: 39.2904, lon: -76.6122, place: 'Baltimore, MD' },
  // Southeast
  '300': { lat: 33.7490, lon: -84.3880, place: 'Atlanta, GA' },
  '331': { lat: 25.7617, lon: -80.1918, place: 'Miami, FL' },
  '328': { lat: 28.5383, lon: -81.3792, place: 'Orlando, FL' },
  '336': { lat: 27.9506, lon: -82.4572, place: 'Tampa, FL' },
  '282': { lat: 35.2271, lon: -80.8431, place: 'Charlotte, NC' },
  '292': { lat: 32.7765, lon: -79.9311, place: 'Charleston, SC' },
  '372': { lat: 36.1627, lon: -86.7816, place: 'Nashville, TN' },
  '381': { lat: 35.1495, lon: -90.0490, place: 'Memphis, TN' },
  '402': { lat: 38.2527, lon: -85.7585, place: 'Louisville, KY' },
  '700': { lat: 29.9511, lon: -90.0715, place: 'New Orleans, LA' },
  // Midwest
  '606': { lat: 41.8781, lon: -87.6298, place: 'Chicago, IL' },
  '631': { lat: 38.6270, lon: -90.1994, place: 'St Louis, MO' },
  '482': { lat: 42.3314, lon: -83.0458, place: 'Detroit, MI' },
  '432': { lat: 39.9612, lon: -82.9988, place: 'Columbus, OH' },
  '441': { lat: 41.4993, lon: -81.6944, place: 'Cleveland, OH' },
  '452': { lat: 39.1031, lon: -84.5120, place: 'Cincinnati, OH' },
  '462': { lat: 39.7684, lon: -86.1581, place: 'Indianapolis, IN' },
  '532': { lat: 43.0389, lon: -87.9065, place: 'Milwaukee, WI' },
  '551': { lat: 44.9778, lon: -93.2650, place: 'Minneapolis, MN' },
  '641': { lat: 39.0997, lon: -94.5786, place: 'Kansas City, MO' },
  // Texas
  '750': { lat: 32.7767, lon: -96.7970, place: 'Dallas, TX' },
  '770': { lat: 29.7604, lon: -95.3698, place: 'Houston, TX' },
  '782': { lat: 29.4241, lon: -98.4936, place: 'San Antonio, TX' },
  '787': { lat: 30.2672, lon: -97.7431, place: 'Austin, TX' },
  // Mountain
  '802': { lat: 39.7392, lon: -104.9903, place: 'Denver, CO' },
  '801': { lat: 40.7608, lon: -111.8910, place: 'Salt Lake City, UT' },
  '850': { lat: 33.4484, lon: -112.0740, place: 'Phoenix, AZ' },
  '871': { lat: 35.0844, lon: -106.6504, place: 'Albuquerque, NM' },
  '891': { lat: 36.1699, lon: -115.1398, place: 'Las Vegas, NV' },
  // West coast
  '900': { lat: 34.0522, lon: -118.2437, place: 'Los Angeles, CA' },
  '902': { lat: 33.7701, lon: -118.1937, place: 'Long Beach, CA' },
  '921': { lat: 32.7157, lon: -117.1611, place: 'San Diego, CA' },
  '941': { lat: 37.7749, lon: -122.4194, place: 'San Francisco, CA' },
  '950': { lat: 37.3382, lon: -121.8863, place: 'San Jose, CA' },
  '958': { lat: 38.5816, lon: -121.4944, place: 'Sacramento, CA' },
  '972': { lat: 45.5152, lon: -122.6784, place: 'Portland, OR' },
  '981': { lat: 47.6062, lon: -122.3321, place: 'Seattle, WA' },
  // Alaska / Hawaii
  '995': { lat: 61.2181, lon: -149.9003, place: 'Anchorage, AK' },
  '968': { lat: 21.3099, lon: -157.8581, place: 'Honolulu, HI' },
};

// Geographic centre of the contiguous US — used as a fallback when the user's
// ZIP prefix isn't in our seed list. Keeps lookups from failing outright.
const USA_CENTER = { lat: 39.5, lon: -98.5, place: 'United States' };

// REGIONAL: future expansion (airport tower/ground/ATIS, NOAA NWR transmitter
// nearest to lat/lon, ham repeaters by lat/lon). Empty for the MVP — the
// universal list plus the user's ZIP-resolved place is the v1 deliverable.
const REGIONAL = [];

function lookupZip(zip) {
  const z = String(zip || '').trim();
  if (!/^\d{5}$/.test(z)) return null;
  const z3 = z.slice(0, 3);
  return ZIP3[z3] || USA_CENTER;
}

// Great-circle distance in miles. Used by REGIONAL filtering once seeded.
function distMi(lat1, lon1, lat2, lon2) {
  const R = 3959;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function stationsForLocation({ lat, lon }) {
  const out = [...UNIVERSAL];
  for (const r of REGIONAL) {
    if (distMi(lat, lon, r.center.lat, r.center.lon) <= r.radiusMi) {
      out.push(...r.stations);
    }
  }
  return out;
}

// PUBSAFETY: lazy-load + cache the gzipped FCC ULS index. First call pays
// the ~50ms decompress cost; subsequent calls are O(1) map lookups.
let _pubsafetyByZip3 = null;
function loadPubsafety() {
  if (_pubsafetyByZip3) return _pubsafetyByZip3;
  const gz = fs.readFileSync(path.join(__dirname, 'pubsafety-by-zip3.json.gz'));
  const json = zlib.gunzipSync(gz).toString('utf8');
  _pubsafetyByZip3 = JSON.parse(json);
  return _pubsafetyByZip3;
}

// Limit per-zip to keep the UI manageable. Top 100 covers every reasonable
// monitoring use; a user who needs more should add custom presets.
const MAX_PUBSAFETY_PER_ZIP = 100;

function pubsafetyForZip(zip5) {
  if (!/^\d{5}$/.test(zip5)) return [];
  const z3 = zip5.slice(0, 3);
  const data = loadPubsafety();
  const entries = data[z3] || [];
  // All entries here are F3E analog FM voice in the 30–870 MHz public-safety
  // bands, so modulation is uniformly NBFM. Category groups everything as
  // Public Safety; the licensee NAME is the per-entry differentiator.
  return entries.slice(0, MAX_PUBSAFETY_PER_ZIP).map((e) => ({
    hz:    e.hz,
    mod:   'nbfm',
    label: e.name || e.cs || `Public Safety ${(e.hz / 1e6).toFixed(4)}`,
    cat:   'Public Safety',
  }));
}

module.exports = {
  UNIVERSAL, ZIP3, USA_CENTER, lookupZip, stationsForLocation, pubsafetyForZip,
};
