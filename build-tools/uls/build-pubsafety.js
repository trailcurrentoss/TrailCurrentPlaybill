#!/usr/bin/env node
/* Build a compact per-area public-safety frequency database from the FCC
   ULS Land Mobile Private weekly dump.

   Pipeline:
     1. Read HD.dat — keep records with service_code in PW (Public Safety
        Pool, Conventional). Skip cancelled/expired/terminated.
     2. Read EM.dat — keep emissions ending in F3E (analog FM voice).
        Anything else (P25 F1E, F1D, F9W combined, etc.) is digital and
        cannot be demodulated by rtl_fm; including it would just give the
        user a list of silent channels.
     3. Read FR.dat — frequencies per (USI, location, antenna).
     4. Read LO.dat — lat/lon per (USI, location).
     5. Join: a station = (frequency, lat, lon, callsign, license_status).
     6. Bucket by 3-digit ZIP centroid using nearest-neighbor on coords.
     7. Output: build-tools/uls/pubsafety-by-zip3.json

   Run: node build-pubsafety.js  (assumes l_LMpriv.zip is in the same dir
   and has been unzipped to ./extracted/) */

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const SRC_DIR = path.join(__dirname, 'extracted');
const OUT     = path.join(__dirname, 'pubsafety-by-zip3.json');

// Service codes to keep. Conservative whitelist — only stuff that's commonly
// analog FM. Adding YW/YP/YF/SY would balloon the database with trunked
// systems whose voice we can't decode.
const KEEP_SERVICE_CODES = new Set(['PW']);

// Active license statuses. A = Active, L = pending? Most common is A and
// "Issued" status. Skip cancelled (C), expired (E), terminated (T).
const KEEP_STATUSES = new Set(['A']);

// US public safety frequency bands. Even with a PW license, irrelevant
// frequencies sometimes appear (microwave links, paging). Filter to bands
// the user actually wants to listen to.
const KEEP_BANDS_MHZ = [
  [30,    50    ],   // Low VHF (still used in rural areas)
  [138,   174   ],   // VHF high (most common public safety)
  [220,   222   ],   // 220 MHz (rare but exists)
  [406,   470   ],   // UHF (PD, fire, EMS)
  [806,   869   ],   // 800 MHz (mostly trunked but conventional exists)
];

function inAllowedBand(mhz) {
  for (const [lo, hi] of KEEP_BANDS_MHZ) if (mhz >= lo && mhz <= hi) return true;
  return false;
}

function dmsToDecimal(deg, min, sec, dir) {
  if (deg === '' || deg == null) return null;
  const d = Number(deg) + Number(min || 0) / 60 + Number(sec || 0) / 3600;
  if (!isFinite(d)) return null;
  return (dir === 'S' || dir === 'W') ? -d : d;
}

async function streamLines(file, onLine) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of rl) onLine(line);
}

async function main() {
  console.log('==> Stage 1: HD.dat (license headers)');
  // HD record layout (pipe-delimited, indexed from 0):
  //   0=record_type, 1=usi, 4=call_sign, 5=license_status, 6=radio_service_code
  const keepUsi = new Set();
  const usiToCallsign = new Map();
  let hdCount = 0, hdKept = 0;
  await streamLines(path.join(SRC_DIR, 'HD.dat'), (line) => {
    hdCount++;
    const f = line.split('|');
    if (f[0] !== 'HD') return;
    const usi      = f[1];
    const callsign = f[4];
    const status   = f[5];
    const service  = f[6];
    if (!KEEP_SERVICE_CODES.has(service)) return;
    if (!KEEP_STATUSES.has(status)) return;
    keepUsi.add(usi);
    usiToCallsign.set(usi, callsign);
    hdKept++;
  });
  console.log(`    scanned ${hdCount} HD rows, kept ${hdKept} licenses`);

  console.log('==> Stage 1b: EN.dat (licensee → zip/state/name)');
  // Most PW licenses are mobile-area licenses with no fixed transmitter
  // coordinates in LO.dat. The licensee's mailing-address ZIP is the right
  // geographic anchor: it's where the agency operates (city hall, county
  // courthouse, sheriff's office, etc.). EN layout (verified against actual
  // wire data — FCC's published spec did not match index-for-index):
  //   0=EN, 1=usi, 4=callsign, 5=entity_type ('L' = licensee), 7=name,
  //   16=city, 17=state, 18=zip
  const usiToLicensee = new Map(); // usi → { name, city, state, zip5 }
  let enCount = 0, enKept = 0;
  await streamLines(path.join(SRC_DIR, 'EN.dat'), (line) => {
    enCount++;
    const f = line.split('|');
    if (f[0] !== 'EN') return;
    const usi = f[1];
    if (!keepUsi.has(usi)) return;
    if (f[5] !== 'L') return;     // Only the actual licensee row, not contacts.
    const zipRaw = (f[18] || '').trim();
    if (!/^\d{5}/.test(zipRaw)) return;   // Some licensees omit zip.
    usiToLicensee.set(usi, {
      name:  (f[7] || '').trim(),
      city:  (f[16] || '').trim(),
      state: (f[17] || '').trim(),
      zip5:  zipRaw.slice(0, 5),
    });
    enKept++;
  });
  console.log(`    scanned ${enCount} EN rows, kept ${enKept} licensees`);

  console.log('==> Stage 2: EM.dat (emissions — analog FM only)');
  // EM: 0=record_type, 1=usi, 5=location_number, 6=antenna_number,
  //     7=frequency_assigned, 9=emission_code
  // Keep (usi, location, antenna, freq) tuples whose emission ends in F3E.
  const analogFreqKey = (usi, loc, ant, freq) => `${usi}|${loc}|${ant}|${freq}`;
  const analogTuples = new Set();
  let emCount = 0, emKept = 0;
  await streamLines(path.join(SRC_DIR, 'EM.dat'), (line) => {
    emCount++;
    const f = line.split('|');
    if (f[0] !== 'EM') return;
    const usi  = f[1];
    if (!keepUsi.has(usi)) return;
    const loc  = f[5];
    const ant  = f[6];
    const freq = f[7];
    const em   = f[9] || '';
    if (!em.endsWith('F3E')) return;
    analogTuples.add(analogFreqKey(usi, loc, ant, freq));
    emKept++;
  });
  console.log(`    scanned ${emCount} EM rows, kept ${emKept} analog-FM emissions`);

  console.log('==> Stage 3: FR.dat (frequencies)');
  // FR layout (per actual data inspection — FCC's docs and the wire data
  // disagreed by one index on location/antenna):
  //   0=record_type, 1=usi, 4=call_sign, 5=frequency_action_performed,
  //   6=location_number, 7=antenna_number, 10=frequency_assigned (MHz)
  const stations = []; // { usi, loc, freqHz }
  let frCount = 0, frKept = 0;
  await streamLines(path.join(SRC_DIR, 'FR.dat'), (line) => {
    frCount++;
    const f = line.split('|');
    if (f[0] !== 'FR') return;
    const usi  = f[1];
    if (!keepUsi.has(usi)) return;
    const loc  = f[6];
    const ant  = f[7];
    const freqMhzStr = f[10];
    if (!freqMhzStr) return;
    const freqMhz = Number(freqMhzStr);
    if (!isFinite(freqMhz)) return;
    if (!inAllowedBand(freqMhz)) return;
    if (!analogTuples.has(analogFreqKey(usi, loc, ant, freqMhzStr))) return;
    stations.push({ usi, loc, freqHz: Math.round(freqMhz * 1e6) });
    frKept++;
  });
  console.log(`    scanned ${frCount} FR rows, kept ${frKept} analog-band freqs`);

  console.log('==> Stage 4: bucket by licensee ZIP3');
  // For each (usi, freqHz) station, look up the licensee in usiToLicensee.
  // The licensee zip = the agency's mailing address (city hall, county
  // courthouse, etc.) which is the correct geographic anchor for a mobile-
  // area public-safety license. Bucket into 3-digit ZIP prefix.
  const byZip3 = Object.create(null); // z3 → array of { hz, cs, name, city, state }
  let bucketed = 0, dropped = 0;
  for (const s of stations) {
    const lic = usiToLicensee.get(s.usi);
    if (!lic) { dropped++; continue; }
    const z3 = lic.zip5.slice(0, 3);
    if (!byZip3[z3]) byZip3[z3] = [];
    byZip3[z3].push({
      hz: s.freqHz,
      cs: usiToCallsign.get(s.usi) || '',
      name:  lic.name,
      city:  lic.city,
      state: lic.state,
    });
    bucketed++;
  }
  console.log(`    bucketed ${bucketed} stations into ${Object.keys(byZip3).length} ZIP3 areas (dropped ${dropped} for missing licensee)`);

  console.log('==> Stage 5: dedupe + sort each ZIP3 bucket');
  // Many licenses share frequencies (e.g. county-wide mutual aid). Keep one
  // entry per (freq, licensee_name) to avoid 50× duplicates per zip while
  // preserving "WHO" labels for distinct agencies on the same channel.
  let totalEntries = 0;
  for (const z3 of Object.keys(byZip3)) {
    const seen = new Map();
    for (const s of byZip3[z3]) {
      const k = `${s.hz}|${s.name}`;
      if (!seen.has(k)) seen.set(k, s);
    }
    byZip3[z3] = Array.from(seen.values()).sort((a, b) => a.hz - b.hz);
    totalEntries += byZip3[z3].length;
  }
  console.log(`    ${totalEntries} unique (freq, licensee) entries`);

  console.log('==> Stage 6: write JSON');
  fs.writeFileSync(OUT, JSON.stringify(byZip3));
  const sz = fs.statSync(OUT).size;
  console.log(`    wrote ${OUT}  (${(sz / 1024).toFixed(1)} KiB)`);
  console.log('==> done');
}

main().catch((e) => { console.error(e); process.exit(1); });
