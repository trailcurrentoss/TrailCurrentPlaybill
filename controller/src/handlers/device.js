/* Device-identity handlers — naming and the bits other rig devices use to
   tell two Playbills apart. The device.id slug is fixed at first run so
   topic subscriptions don't break; everything mutable lives behind
   explicit actions registered here.

   Discovery story: the controller publishes a retained presence payload on
   `local/playbill/<deviceId>/system/status` carrying {online, name,
   hostname, version, uptimeSec, ts, ...}. PWAs (Headwaters), CAN nodes
   (Peregrine, others), and other rig software read the `name` field there
   to distinguish "Living Room" from "Bunkhouse" without caring about the
   underlying topic slug. Setting that name is what these handlers expose. */

'use strict';

function register({ bus, state, settings }) {
  // device.setName — rename this Playbill in a way that's visible everywhere
  // that listens to presence. Persists to settings.json + republishes the
  // retained system/status payload via the existing state→MQTT fan-out.
  bus.register('device.setName', async (cmd) => {
    const raw = (cmd && (cmd.value && cmd.value.name !== undefined ? cmd.value.name : cmd.value));
    if (typeof raw !== 'string') {
      throw new Error('device.setName: value must be a string (the new name)');
    }
    const name = raw.trim();
    if (name.length < 1 || name.length > 64) {
      throw new Error('device.setName: name must be 1–64 characters');
    }

    // Shallow-merge into the device subtree so id + canInstance survive.
    // (settings.patch is itself a shallow merge across top-level keys, so
    // we hand it the whole device subobject pre-merged.)
    const cur = settings.get() || {};
    const nextDevice = { ...(cur.device || {}), name };
    await settings.patch({ device: nextDevice });

    const next = settings.get();
    state.patch({
      settings: next,
      device: { ...state.get().device, id: next.device.id, name: next.device.name },
    });
    return { ok: true, name };
  });

  // device.get — small read accessor so PWAs/CAN agents can ask for the
  // current identity without subscribing to presence. Returns the public
  // shape (no secrets).
  bus.register('device.get', async () => {
    const d = state.get().device || {};
    return {
      id:       d.id,
      name:     d.name,
      hostname: d.hostname,
      version:  d.version,
    };
  });
}

module.exports = { register };
