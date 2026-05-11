/* SettingsStore — schema-validated, file-backed configuration.

   One store per top-level category (settings, connection, per-source).
   Each store reads/writes one JSON file at fixed mode 0600 — never wider —
   because we conflate "this is config" with "this might contain a secret"
   in a desktop app installed by an end user.

   Writes are atomic: write to a sibling .tmp, fsync, rename. A power cut
   mid-write leaves the previous file intact rather than half-written. */

'use strict';

const fs = require('fs');
const path = require('path');
const { promises: fsp } = fs;
// Use Ajv's Draft 2020-12 build — our schemas declare $schema 2020-12 so
// the default Draft-7 Ajv build refuses them. ajv-formats works with both.
const Ajv = require('ajv/dist/2020').default || require('ajv/dist/2020');
const addFormats = require('ajv-formats').default || require('ajv-formats');

const { CONFIG_DIR } = require('./paths');

class SettingsStore {
  /**
   * @param {object} opts
   * @param {string} opts.filePath  absolute path to the JSON file
   * @param {object} opts.schema    JSON Schema (Draft 2020-12) for the payload
   * @param {object} [opts.defaults] initial value when the file does not exist yet
   * @param {boolean} [opts.required=false] true if the file MUST exist for the controller to operate (used for connection.json)
   */
  constructor({ filePath, schema, defaults = {}, required = false }) {
    if (!filePath) throw new Error('SettingsStore: filePath is required');
    if (!schema) throw new Error('SettingsStore: schema is required');

    this._filePath = filePath;
    this._schema = schema;
    this._required = required;
    this._defaults = defaults;
    this._data = null;
    this._loaded = false;

    const ajv = new Ajv({
      allErrors: true,
      useDefaults: true,
      strict: true,
    });
    addFormats(ajv);
    this._validate = ajv.compile(schema);
  }

  /** True if the file existed on disk at load time (i.e., user has configured it). */
  isPresent() { return this._loaded && this._data !== null; }

  /** Load from disk. Idempotent — safe to call again after a write. */
  async load() {
    try {
      const text = await fsp.readFile(this._filePath, 'utf8');
      const parsed = JSON.parse(text);
      if (!this._validate(parsed)) {
        const errs = JSON.stringify(this._validate.errors);
        throw new Error(`Invalid settings at ${this._filePath}: ${errs}`);
      }
      this._data = parsed;
    } catch (e) {
      if (e.code === 'ENOENT') {
        // File missing. Required stores stay null (controller will surface
        // "unconfigured"); optional stores fall back to defaults.
        this._data = this._required ? null : structuredClone(this._defaults);
      } else {
        throw e;
      }
    }
    this._loaded = true;
  }

  /** Read the whole config (a frozen snapshot) or null if not yet present. */
  get() {
    if (this._data === null) return null;
    return this._data;
  }

  /**
   * Replace the configuration wholesale. Validates first; only persists if valid.
   * Atomic: tmp file + rename. Always written at file mode 0600.
   */
  async replace(next) {
    if (!this._validate(next)) {
      const errs = JSON.stringify(this._validate.errors);
      throw new Error(`Refused to write invalid settings to ${this._filePath}: ${errs}`);
    }
    await fsp.mkdir(path.dirname(this._filePath), { recursive: true, mode: 0o700 });
    const tmp = this._filePath + '.tmp';
    const text = JSON.stringify(next, null, 2) + '\n';
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.rename(tmp, this._filePath);
    this._data = next;
  }

  /**
   * Shallow-merge a partial update into the current config and persist.
   * Convenience wrapper over replace() for the common case.
   */
  async patch(part) {
    const cur = this._data || (this._required ? {} : structuredClone(this._defaults));
    const next = { ...cur, ...part };
    await this.replace(next);
  }

  /** Delete the on-disk file. Used when the user "forgets" credentials. */
  async clear() {
    try { await fsp.unlink(this._filePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this._data = this._required ? null : structuredClone(this._defaults);
  }
}

module.exports = SettingsStore;
module.exports.CONFIG_DIR = CONFIG_DIR;
