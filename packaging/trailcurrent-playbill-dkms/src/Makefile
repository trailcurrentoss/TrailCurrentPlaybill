# Out-of-tree Kbuild for trailcurrent-playbill-dkms.
#
# This builds the USB-DVB driver chain the Radxa Q6A kernel ships without:
#
#   em28xx.ko       Empia EM28xx USB bridge (incl. EM28174 in dualHD-01595).
#                   Composite of em28xx-core + em28xx-i2c + em28xx-cards +
#                   em28xx-camera.
#   em28xx-dvb.ko   DVB extension for em28xx — needed to expose
#                   /dev/dvb/adapterN. Links many demod/tuner headers but
#                   uses runtime symbol_request() for them, so unbuilt demod
#                   modules return NULL gracefully at attach time (the
#                   dualHD-01595 code path uses lgdt3306a + si2157 via the
#                   newer dvb_module_probe() string-name interface).
#   lgdt3306a.ko    LG LGDT3306A ATSC/QAM demodulator — the dualHD-01595's
#                   demod IC.
#   si2157.ko       Silicon Labs Si2157 RF tuner — the dualHD-01595's tuner
#                   IC. (Note: the older `si2148` and `si2158` headers in the
#                   kernel source are for similar but distinct parts; the
#                   01595 specifically uses si2157.)
#   tveeprom.ko     Hauppauge analog/digital EEPROM parser — em28xx-cards.c
#                   calls tveeprom_hauppauge_analog() directly, so this
#                   must load before em28xx (depmod handles the ordering).
#
# em28xx-v4l / em28xx-alsa / em28xx-rc are intentionally NOT built. The
# dualHD-01595 is a tuner module, no analog video / audio / IR remote. The
# .c sources for those parts are still in /usr/src/ in case a future scope
# wants them — just add the obj-m lines below.
#
# When the kernel build system invokes us via `make -C $KSRC M=$(pwd)
# modules`, this Makefile is read in Kbuild syntax. Header search path
# `-I$(src)` lets em28xx-dvb.c find lgdt3306a.h etc. in the same source dir.

obj-m += em28xx.o
em28xx-y := em28xx-core.o em28xx-i2c.o em28xx-cards.o em28xx-camera.o

obj-m += em28xx-dvb.o

obj-m += lgdt3306a.o
obj-m += si2157.o
obj-m += tveeprom.o

ccflags-y := -I$(src) -I$(src)/drx39xyj

# Gate the IS_REACHABLE() guards in our shipped demod/tuner headers so the
# headers we BUILD (lgdt3306a, si2157) provide real prototypes instead of
# static-inline stubs that would conflict with their .c definitions.
#
# Headers we ship but DON'T build (cxd2820r, drxd, drxk, lgdt3305, lgdt330x,
# mt352, mt2060, qt1010, s5h1409, s921, tda1002x, etc.) intentionally have
# their CONFIG flags left undefined — that way their headers provide the
# stub-inline that just returns NULL, which is correct for em28xx-dvb's
# dvb_attach() calls on board types we don't care about. The dualHD-01595
# code path uses dvb_module_probe() string-name runtime loads instead, so
# lgdt3306a + si2157 are loaded by name and don't need to be link-time
# resolved from em28xx-dvb.ko.
ccflags-y += -DCONFIG_DVB_LGDT3306A=1
ccflags-y += -DCONFIG_MEDIA_TUNER_SI2157=1
