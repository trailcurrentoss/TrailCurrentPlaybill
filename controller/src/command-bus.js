/* CommandBus — single dispatcher for every action in the system.

   Three input sources fan in: the local GUI over IPC, MQTT-arriving
   commands from other devices, and internal callers (timers, source
   plugins reacting to upstream events). All three call dispatch().

   Each command is a typed object with a string `action` field. Handlers
   are registered once at startup and cannot be replaced — if you need
   different behavior in different states, branch inside the handler.

   The bus is intentionally minimal. No middleware chain, no priorities,
   no sagas. If we ever need those, they should live in handlers. */

'use strict';

const Ajv = require('ajv/dist/2020').default || require('ajv/dist/2020');
const addFormats = require('ajv-formats').default || require('ajv-formats');

const commandsSchema = require('./schema/commands.schema.json');

class CommandBus {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.validate=true]  apply commands.schema.json before dispatch
   * @param {string}  [opts.policy='strict'] 'strict' = throw on unknown actions,
   *                                          'warn'   = log + dispatch anyway
   *                                          'off'    = skip validation entirely
   */
  constructor(opts = {}) {
    this._handlers = new Map(); // action string → async fn(cmd, ctx)

    const validate = opts.validate !== false;
    this._policy = opts.policy || (validate ? 'strict' : 'off');

    // Per-action validator map. We deliberately do NOT compile commandsSchema
    // as a single oneOf with a discriminator — Ajv reports errors from EVERY
    // branch in that mode, drowning the real fault. Compiling per branch
    // gives us a single-branch validation that produces actionable errors.
    this._validators = new Map();
    if (this._policy !== 'off') {
      const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
      addFormats(ajv);
      // Register the whole schema so $refs and $defs resolve, then compile each
      // branch's $defs entry under its own action const.
      ajv.addSchema(commandsSchema, commandsSchema.$id || 'commands.schema');
      for (const branch of (commandsSchema.oneOf || [])) {
        const refPath = branch.$ref;        // e.g. "#/$defs/SystemEcho"
        if (!refPath || !refPath.startsWith('#/$defs/')) continue;
        const defName = refPath.slice('#/$defs/'.length);
        const def = commandsSchema.$defs && commandsSchema.$defs[defName];
        if (!def) continue;
        const actionConst =
          def.properties && def.properties.action && def.properties.action.const;
        if (typeof actionConst !== 'string') continue;
        this._validators.set(actionConst, ajv.compile(def));
      }
    }
  }

  register(action, handler) {
    if (typeof action !== 'string' || !action) {
      throw new Error('register: action must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new Error('register: handler must be a function');
    }
    if (this._handlers.has(action)) {
      throw new Error(`register: handler already registered for "${action}"`);
    }
    this._handlers.set(action, handler);
  }

  has(action) {
    return this._handlers.has(action);
  }

  /**
   * Dispatch a command. Returns whatever the handler returns (typically
   * an ack object). Throws if no handler is registered.
   *
   * `ctx` carries information about the originator so handlers can decide
   * who to talk back to (e.g., which IPC client made the request, whether
   * the command came in over MQTT and should be confirmed there).
   */
  async dispatch(cmd, ctx = {}) {
    if (!cmd || typeof cmd.action !== 'string') {
      throw new Error('dispatch: command must have a string `action`');
    }

    if (this._policy !== 'off') {
      const v = this._validators.get(cmd.action);
      if (!v) {
        const msg = `unknown command action "${cmd.action}"`;
        if (this._policy === 'strict') throw new Error(msg);
        if (this._policy === 'warn')   console.warn('[command-bus] ' + msg);
      } else if (!v(cmd)) {
        const detail = (v.errors || []).map(e =>
          `${e.instancePath || '/'} ${e.message}`).join('; ');
        const msg = `command schema rejected "${cmd.action}": ${detail}`;
        if (this._policy === 'strict') throw new Error(msg);
        if (this._policy === 'warn')   console.warn('[command-bus] ' + msg);
      }
    }

    const handler = this._handlers.get(cmd.action);
    if (!handler) {
      throw new Error(`dispatch: no handler for "${cmd.action}"`);
    }
    return await handler(cmd, ctx);
  }

  listActions() {
    return [...this._handlers.keys()].sort();
  }
}

module.exports = CommandBus;
