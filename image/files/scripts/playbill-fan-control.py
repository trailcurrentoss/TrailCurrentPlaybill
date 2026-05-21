#!/usr/bin/env python3
"""
TrailCurrent Playbill — 5 V cooling-fan control daemon.

Drives the fan PWM input wired to header PIN_8 (gpio22 on /dev/gpiochip4)
with a software-PWM signal whose duty cycle tracks the maximum CPU core
temperature. Targets:

    ≤ MIN_TEMP_C  →  0 %   (fan off)
    ≥ MAX_TEMP_C  →  100 % (fan full)
    in between    →  linear ramp

Implemented in pure stdlib + ctypes against libgpiod.so.2 so the daemon
adds no Python dependency to the base image. `python3-libgpiod` is NOT
required.

Hardware preconditions (see image/overlays/...-playbill-pwm-fan.dts):
  - serial@994000 (qcom,geni-debug-uart) MUST be disabled, otherwise the
    kernel UART driver holds gpio22 and the line acquire below will fail
    with EBUSY.
  - The kernel cmdline must NOT carry `console=ttyMSM0` or `earlycon`
    (rootfs.jsonnet hook 20 strips both).

PWM frequency choice:
  200 Hz. Low enough that the busy-wait per cycle is ~5 ms (cheap for the
  scheduler), high enough to be inaudible on a small 5 V fan driving its
  PWM input via the typical onboard transistor. Validated 2026-05-20 on the
  prototype: smooth audible speed ramp across 0–100 % duty.

Exit behaviour:
  On SIGTERM / SIGINT / normal exit, drops gpio22 LOW and releases the
  line so the next start of the service (or a reboot leaving the line
  unclaimed) sees a known state.
"""

import ctypes
import errno
import glob
import os
import signal
import sys
import time

# ── Configuration ───────────────────────────────────────────────────────────
CHIP_PATH = b"/dev/gpiochip4"
LINE_OFFSET = 22  # PIN_8

PWM_FREQ_HZ = 200
PWM_PERIOD = 1.0 / PWM_FREQ_HZ

# Temperature → duty curve. Passive-first profile: the Q6A's heat-spreader
# alone handles idle and light-load thermals; the fan only turns on under
# sustained CPU load. Live-tuned 2026-05-20: at MIN_TEMP_C=40 °C the fan
# was running constantly at the (smooth-spin floor) 40 % duty during normal
# desktop use and remained audibly whiny, so the threshold was pushed up.
MIN_TEMP_C = 60.0   # at or below this, fan off
MAX_TEMP_C = 80.0   # at or above this, fan full
# 80 °C full-fan target leaves ~10–15 °C headroom before the kernel's
# thermal throttle (≈95 °C on QCS6490 cpu*-thermal zones) engages.

# Minimum non-zero duty cycle. Below this, the prototype 5 V fan whines —
# partly from low rotor torque (stiction stutter) and partly from PWM
# duty-cycle harmonics in the audible band. Live-tuned 2026-05-20 against
# user-perceived noise on the actual hardware:
#   0.40 → whiny throughout running
#   0.55 → fine while spinning up under sustained load, but exposed
#          on the slow cool-down (≈10 s spent at this duty as temp
#          drifts back through the 60–70 °C band)
#   0.75 → smooth across the whole running envelope, including
#          cool-down. Confirmed by the user as "perfectly fine".
# Trade-off accepted (explicit user preference): the fan jumps from OFF
# straight to a confidently-spinning 75 % — audibly louder for short
# bursts but never produces the high-pitch buzz the lower duty range
# was making. Below 60 °C the fan is fully OFF regardless of this floor.
MIN_RUNNING_DUTY = 0.75

# Sample the thermal zones this often (seconds). The PWM bit-bang continues
# between samples at the previously-computed duty cycle.
SAMPLE_INTERVAL_S = 2.0

# Kickstart: on every OFF → ON transition, drive the fan at 100 % duty for
# this many seconds before dropping to MIN_RUNNING_DUTY. Small 5 V fans need
# a brief full-power kick to overcome rotor stiction; starting them straight
# at MIN_RUNNING_DUTY produces a short high-pitch stutter while the motor
# struggles to break static friction. 1.5 s is empirically enough on the
# prototype fan to reach a steady spin before we drop to the steady-state
# duty cycle (live-tuned 2026-05-20). Kickstart applies only on transitions
# from a stopped fan, not on duty-cycle changes inside the running range.
KICKSTART_DURATION_S = 1.5

# Hysteresis: avoid clicking the fan on/off at the MIN_TEMP_C boundary.
# Once the fan turns on, leave it running until temp drops MIN_TEMP_HYST_C
# below MIN_TEMP_C. 5 °C gives the heat-spreader enough time to actually
# move heat out before the fan re-engages.
MIN_TEMP_HYST_C = 5.0


# ── libgpiod via ctypes ─────────────────────────────────────────────────────
_lib = ctypes.CDLL("libgpiod.so.2", use_errno=True)
_lib.gpiod_chip_open.restype = ctypes.c_void_p
_lib.gpiod_chip_open.argtypes = [ctypes.c_char_p]
_lib.gpiod_chip_get_line.restype = ctypes.c_void_p
_lib.gpiod_chip_get_line.argtypes = [ctypes.c_void_p, ctypes.c_uint]
_lib.gpiod_line_request_output.restype = ctypes.c_int
_lib.gpiod_line_request_output.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
_lib.gpiod_line_set_value.restype = ctypes.c_int
_lib.gpiod_line_set_value.argtypes = [ctypes.c_void_p, ctypes.c_int]
_lib.gpiod_line_release.restype = None
_lib.gpiod_line_release.argtypes = [ctypes.c_void_p]
_lib.gpiod_chip_close.restype = None
_lib.gpiod_chip_close.argtypes = [ctypes.c_void_p]


def _cpu_thermal_files():
    """All cpu*-thermal zone temp files. Resolved once at startup."""
    paths = []
    for zone in sorted(glob.glob("/sys/class/thermal/thermal_zone*")):
        try:
            with open(os.path.join(zone, "type"), "r") as fh:
                zt = fh.read().strip()
        except OSError:
            continue
        if zt.startswith("cpu") and zt.endswith("-thermal"):
            paths.append(os.path.join(zone, "temp"))
    return paths


def _read_max_cpu_temp_c(paths):
    """Return the hottest cpu*-thermal zone in °C, or None if all reads fail."""
    hottest = None
    for p in paths:
        try:
            with open(p, "r") as fh:
                milli = int(fh.read().strip())
        except (OSError, ValueError):
            continue
        c = milli / 1000.0
        if hottest is None or c > hottest:
            hottest = c
    return hottest


def _temp_to_duty(temp_c, fan_running):
    """Map a CPU temperature to a duty cycle in [0.0, 1.0]."""
    if temp_c is None:
        # Sensor read failure → run fan at 60 % as a safety default.
        return 0.6
    # Hysteresis on the OFF transition.
    if fan_running:
        threshold = MIN_TEMP_C - MIN_TEMP_HYST_C
    else:
        threshold = MIN_TEMP_C
    if temp_c <= threshold:
        return 0.0
    if temp_c >= MAX_TEMP_C:
        return 1.0
    duty = (temp_c - MIN_TEMP_C) / (MAX_TEMP_C - MIN_TEMP_C)
    # Snap to the smooth-spin floor. See MIN_RUNNING_DUTY for the reason.
    if 0.0 < duty < MIN_RUNNING_DUTY:
        duty = MIN_RUNNING_DUTY
    return duty


def main():
    cpu_temp_paths = _cpu_thermal_files()
    if not cpu_temp_paths:
        print("fan-control: no cpu*-thermal zones found; running fan at 60 % as safety", file=sys.stderr)

    chip = _lib.gpiod_chip_open(CHIP_PATH)
    if not chip:
        err = ctypes.get_errno()
        print(f"fan-control: gpiod_chip_open({CHIP_PATH.decode()}) failed: {os.strerror(err)} ({err})", file=sys.stderr)
        return 1
    line = _lib.gpiod_chip_get_line(chip, LINE_OFFSET)
    if not line:
        err = ctypes.get_errno()
        print(f"fan-control: gpiod_chip_get_line({LINE_OFFSET}) failed: {os.strerror(err)} ({err})", file=sys.stderr)
        _lib.gpiod_chip_close(chip)
        return 1
    rc = _lib.gpiod_line_request_output(line, b"playbill-fan-control", 0)
    if rc != 0:
        err = ctypes.get_errno()
        msg = os.strerror(err)
        hint = ""
        if err == errno.EBUSY:
            hint = (" (line already owned — is the playbill-pwm-fan overlay applied"
                    " and console=ttyMSM0 dropped from cmdline?)")
        print(f"fan-control: request_output failed: {msg} ({err}){hint}", file=sys.stderr)
        _lib.gpiod_chip_close(chip)
        return 1

    state = {"duty": 0.0, "running": False, "stop": False}

    def cleanup(*_a):
        state["stop"] = True

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    last_sample = 0.0
    print("fan-control: started; reading temps from", len(cpu_temp_paths), "cpu thermal zone(s)", flush=True)

    try:
        while not state["stop"]:
            now = time.monotonic()
            if now - last_sample >= SAMPLE_INTERVAL_S:
                temp = _read_max_cpu_temp_c(cpu_temp_paths)
                new_duty = _temp_to_duty(temp, state["running"])
                # Quantize to nearest 5 % to keep the PWM math/log noise down.
                new_duty = round(new_duty * 20) / 20.0
                if abs(new_duty - state["duty"]) >= 0.05 or state["duty"] == 0.0 and new_duty > 0.0:
                    temp_str = f"{temp:.1f}°C" if temp is not None else "n/a"
                    print(f"fan-control: temp={temp_str} duty={new_duty*100:.0f}%", flush=True)
                state["duty"] = new_duty
                state["running"] = new_duty > 0.0
                last_sample = now

            duty = state["duty"]
            if duty <= 0.0:
                _lib.gpiod_line_set_value(line, 0)
                # Sleep until the next sample without busy-waiting.
                time.sleep(min(SAMPLE_INTERVAL_S, 0.5))
                continue
            if duty >= 1.0:
                _lib.gpiod_line_set_value(line, 1)
                time.sleep(min(SAMPLE_INTERVAL_S, 0.5))
                continue
            high_t = PWM_PERIOD * duty
            low_t = PWM_PERIOD - high_t
            _lib.gpiod_line_set_value(line, 1)
            time.sleep(high_t)
            _lib.gpiod_line_set_value(line, 0)
            time.sleep(low_t)
    finally:
        _lib.gpiod_line_set_value(line, 0)
        _lib.gpiod_line_release(line)
        _lib.gpiod_chip_close(chip)
        print("fan-control: exited; gpio22 dropped LOW and released.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
