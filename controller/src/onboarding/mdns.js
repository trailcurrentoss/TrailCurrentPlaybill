/* mDNS / Bonjour advertisement for unclaimed Playbills.

   Implements the spec at docs/app/onboarding.md §1: publish a
   `_trailcurrent._tcp` service on port 80 with TXT records carrying
   `type=playbill`, `fw`, and (optionally) `name`/`deviceId`/`canInstance`.

   Lifecycle:
     start() — publish the record. Idempotent — calling twice is safe.
     stop()  — withdraw the record cleanly. Always call on SIGTERM so
               the next browse from any device on the LAN doesn't see
               a stale entry.

   Once a Playbill is claimed (connection.json present), index.js stops
   this so already-onboarded devices stop showing up in PWA scans. */

'use strict';

const os = require('os');
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPE = 'trailcurrent';   // bonjour-service auto-prefixes "_" and suffixes "._tcp"
const SERVICE_PORT = 80;               // matches Headwaters' hardcoded http://<hostname>.local

class MdnsAdvertiser {
  /**
   * @param {object} opts
   * @param {() => object} opts.getDeviceInfo  reads {name, deviceId, canInstance, fw} at publish time
   */
  constructor({ getDeviceInfo }) {
    if (typeof getDeviceInfo !== 'function') {
      throw new Error('MdnsAdvertiser: getDeviceInfo callback required');
    }
    this._getDeviceInfo = getDeviceInfo;
    this._bonjour = null;
    this._service = null;
  }

  isRunning() { return !!this._service; }

  start() {
    if (this._service) return;            // already published
    if (!this._bonjour) this._bonjour = new Bonjour();

    const info = this._getDeviceInfo() || {};
    // TXT-record values must be strings (per RFC 6763). Numbers and nulls
    // need explicit conversion / omission.
    const txt = { type: 'playbill', fw: String(info.fw || 'unknown') };
    if (info.name)              txt.name        = String(info.name);
    if (info.deviceId)          txt.deviceId    = String(info.deviceId);
    if (info.canInstance != null) txt.canInstance = String(info.canInstance);

    this._service = this._bonjour.publish({
      name: 'TrailCurrent Playbill (' + (info.name || os.hostname()) + ')',
      type: SERVICE_TYPE,
      port: SERVICE_PORT,
      txt,
    });

    this._service.on('up', () => {
      console.log('[mdns] _trailcurrent._tcp published on port ' + SERVICE_PORT);
    });
    this._service.on('error', (err) => {
      console.error('[mdns] publish error:', err.message);
    });
  }

  /** Re-publish with updated TXT after device.name changes mid-flight. */
  refresh() {
    if (!this._service) return;
    this.stop();
    this.start();
  }

  async stop() {
    if (this._service) {
      try { this._service.stop(); } catch (_) { /* best-effort */ }
      this._service = null;
    }
    if (this._bonjour) {
      try { await new Promise((r) => this._bonjour.destroy(r)); } catch (_) {}
      this._bonjour = null;
    }
  }
}

module.exports = MdnsAdvertiser;
module.exports.SERVICE_PORT = SERVICE_PORT;
