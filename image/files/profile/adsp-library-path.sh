# TrailCurrent Playbill — DSP library search path.
#
# Qualcomm QNN / FastRPC clients (libQnnHtp*, genie-t2t-run, etc.) load
# Hexagon-side skeleton libraries by walking ADSP_LIBRARY_PATH. If unset,
# they only check the binary's CWD and miss /usr/lib/dsp/cdsp where the
# system-installed Skel libs land. Set it for every interactive shell and
# every login so any QNN-using app inherits it.
#
# Order matches the troubleshooting recipe at
# https://gist.github.com/Foadsf/2972e8059102ad9bc9c5848ae1fc7cc3
export ADSP_LIBRARY_PATH="/usr/lib/dsp/cdsp:/usr/lib/dsp/adsp:/dsp"
