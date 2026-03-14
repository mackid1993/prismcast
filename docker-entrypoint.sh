#!/bin/bash
# docker-entrypoint.sh
# 2026.03.13

set -e

# Set configuration defaults for the virtual display, VNC, and noVNC.
DISPLAY_NUM=${DISPLAY_NUM:-99}
SCREEN_WIDTH=${SCREEN_WIDTH:-1920}
SCREEN_HEIGHT=${SCREEN_HEIGHT:-1080}
SCREEN_DEPTH=${SCREEN_DEPTH:-24}
VNC_PORT=${VNC_PORT:-5900}
NOVNC_PORT=${NOVNC_PORT:-6080}

# Set up XDG_RUNTIME_DIR (required by libva to avoid "XDG_RUNTIME_DIR not set" errors).
XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/runtime-root}
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export XDG_RUNTIME_DIR

# Auto-select the Intel VA-API driver when a DRI render node is present and LIBVA_DRIVER_NAME hasn't been set explicitly.
# iHD is the driver for Intel Gen 9+ (Skylake and newer). Override with LIBVA_DRIVER_NAME=i965 for older hardware.
if [ -z "$LIBVA_DRIVER_NAME" ] && [ -e /dev/dri/renderD128 ]; then
  export LIBVA_DRIVER_NAME=iHD
fi

# Resolve PrismCast directories from environment variables, falling back to the same defaults PrismCast uses internally.
DATA_DIR="${PRISMCAST_DATA_DIR:-/root/.prismcast}"
LOGFILE="${PRISMCAST_LOG_FILE:-${DATA_DIR}/prismcast.log}"

export DISPLAY=:${DISPLAY_NUM}

echo "Starting PrismCast with noVNC support..."
echo "  Display: ${DISPLAY}"
echo "  Screen: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}"
echo "  VNC Port: ${VNC_PORT}"
echo "  noVNC Port: ${NOVNC_PORT}"
echo "  PrismCast Port: ${PORT:-5589}"
echo "  Data Directory: ${DATA_DIR}"
if [ -e /dev/dri/renderD128 ]; then
  echo "  Intel GPU: /dev/dri/renderD128 present (LIBVA_DRIVER_NAME=${LIBVA_DRIVER_NAME:-not set})"
else
  echo "  Intel GPU: no DRI device found, using software rendering"
fi

# Graceful shutdown handler. We terminate PrismCast first because it has its own shutdown handler that closes the browser and active streams cleanly. After
# PrismCast exits, we kill the remaining background services (Xvfb, x11vnc, noVNC, tail).
cleanup() {
  echo "Shutting down..."
  if [ -n "$PRISMCAST_PID" ]; then
    kill -TERM $PRISMCAST_PID 2>/dev/null || true
    wait $PRISMCAST_PID 2>/dev/null || true
  fi
  kill $(jobs -p) 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# Remove stale X11 lock files from previous container runs.
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM}

# Ensure the DRI render node is accessible for VA-API hardware video decoding.
if [ -e /dev/dri/renderD128 ]; then
  chmod g+rw /dev/dri/renderD128 2>/dev/null || true
fi

# Generate xorg.conf with the correct resolution and refresh rate. Chrome's compositor syncs to the display's reported refresh rate — a proper modeline ensures Chrome
# produces frames at the target rate, just like a real monitor. This is the key difference between Linux (virtual display) and macOS (real display).
TARGET_FPS=${FRAME_RATE:-60}
MODE_NAME="${SCREEN_WIDTH}x${SCREEN_HEIGHT}_${TARGET_FPS}.00"

# Compute an approximate CVT modeline for the target resolution and refresh rate. The pixel clock and blanking values don't need to be exact for a virtual display —
# the dummy driver just needs a valid modeline with the correct refresh rate so Chrome's compositor sees the right Hz value.
H=${SCREEN_WIDTH}
V=${SCREEN_HEIGHT}
HTOTAL=$((H + H / 5))
VTOTAL=$((V + V / 20))
PCLK=$(awk "BEGIN {printf \"%.2f\", ${HTOTAL} * ${VTOTAL} * ${TARGET_FPS} / 1000000}")
HFP=$((H + H / 40))
HSP=$((H + H / 10))
VFP=$((V + 3))
VSP=$((V + 6))

XORG_CONF="/etc/X11/xorg.conf"
cat > "${XORG_CONF}" <<XORGEOF
Section "ServerFlags"
    Option "DontVTSwitch"       "true"
    Option "AllowMouseOpenFail" "true"
    Option "PciForceNone"       "true"
    Option "AutoEnableDevices"  "false"
    Option "AutoAddDevices"     "false"
EndSection

Section "InputDevice"
    Identifier "dummy_mouse"
    Driver     "void"
EndSection

Section "InputDevice"
    Identifier "dummy_keyboard"
    Driver     "void"
EndSection

Section "Device"
    Identifier "dummy_videocard"
    Driver     "dummy"
    Option     "ConstantDPI" "true"
    VideoRam   256000
EndSection

Section "Monitor"
    Identifier "dummy_monitor"
    HorizSync   1.0 - 200.0
    VertRefresh 1.0 - 200.0
    Modeline "${MODE_NAME}" ${PCLK} ${H} ${HFP} ${HSP} ${HTOTAL} ${V} ${VFP} ${VSP} ${VTOTAL} -hsync +vsync
EndSection

Section "Screen"
    Identifier "dummy_screen"
    Device     "dummy_videocard"
    Monitor    "dummy_monitor"
    DefaultDepth 24
    SubSection "Display"
        Depth  24
        Modes  "${MODE_NAME}"
        Virtual ${SCREEN_WIDTH} ${SCREEN_HEIGHT}
    EndSubSection
EndSection

Section "ServerLayout"
    Identifier "dummy_layout"
    Screen     "dummy_screen"
    InputDevice "dummy_mouse"    "CorePointer"
    InputDevice "dummy_keyboard" "CoreKeyboard"
EndSection
XORGEOF

echo "Starting Xorg with dummy driver (${SCREEN_WIDTH}x${SCREEN_HEIGHT}@${TARGET_FPS}Hz)..."
Xorg ${DISPLAY} \
  -noreset \
  -nolisten tcp \
  -ac \
  -config "${XORG_CONF}" \
  +extension GLX \
  +extension RANDR \
  +extension RENDER &
XORG_PID=$!
sleep 2

# Verify that Xorg started successfully.
if ! kill -0 $XORG_PID 2>/dev/null; then
  echo "ERROR: Xorg failed to start. Check container logs."
  cat /var/log/Xorg.0.log 2>/dev/null | tail -20
  exit 1
fi
echo "Xorg started successfully (${SCREEN_WIDTH}x${SCREEN_HEIGHT}@${TARGET_FPS}Hz)."

# Start x11vnc (VNC server for the virtual display).
echo "Starting x11vnc..."
if [ -f /root/.vnc/passwd ]; then
  # Use an existing VNC password file if one has been configured.
  x11vnc -display ${DISPLAY} -forever -shared -rfbauth /root/.vnc/passwd -rfbport ${VNC_PORT} -quiet &
else
  # No existing password file. If NOVNC_PASSWORD is set, create one from the environment variable. Otherwise, run without authentication.
  if [ -n "$NOVNC_PASSWORD" ]; then
    x11vnc -storepasswd "$NOVNC_PASSWORD" /root/.vnc/passwd
    x11vnc -display ${DISPLAY} -forever -shared -rfbauth /root/.vnc/passwd -rfbport ${VNC_PORT} -quiet &
  else
    x11vnc -display ${DISPLAY} -forever -shared -nopw -rfbport ${VNC_PORT} -quiet &
  fi
fi
X11VNC_PID=$!
sleep 1

# Verify that x11vnc started successfully.
if ! kill -0 $X11VNC_PID 2>/dev/null; then
  echo "ERROR: x11vnc failed to start."
  exit 1
fi
echo "x11vnc started successfully."

# Start noVNC (web-based VNC client).
echo "Starting noVNC..."
/usr/share/novnc/utils/novnc_proxy --vnc localhost:${VNC_PORT} --listen ${NOVNC_PORT} &
NOVNC_PID=$!
sleep 1

# Verify that noVNC started successfully.
if ! kill -0 $NOVNC_PID 2>/dev/null; then
  echo "ERROR: noVNC failed to start."
  exit 1
fi
echo "noVNC started successfully."

echo ""
echo "=============================================="
echo "  noVNC available at: http://localhost:${NOVNC_PORT}/vnc.html"
echo "  PrismCast UI at:    http://localhost:${PORT:-5589}"
echo "=============================================="
echo ""

# Start PrismCast in the background. PrismCast logs to a file by default.
echo "Starting PrismCast..."

# Ensure the data directory exists before PrismCast starts writing to it.
mkdir -p "$DATA_DIR"

# Create a custom Chrome data directory if specified. PrismCast creates this internally, but the parent path must exist for Docker volume mounts to work.
if [ -n "$PRISMCAST_CHROME_DATA_DIR" ]; then
  mkdir -p "$PRISMCAST_CHROME_DATA_DIR"
fi

# Launch PrismCast, forwarding any command-line arguments from docker run.
prismcast "$@" &
PRISMCAST_PID=$!

# Wait for PrismCast to create its log file (up to 10 seconds).
for i in {1..20}; do
  if [ -f "$LOGFILE" ]; then
    break
  fi
  sleep 0.5
done

# Tail the log file to stdout so that Portainer and docker logs can display PrismCast output. We use -n 0 to skip existing log entries and only show new ones.
if [ -f "$LOGFILE" ]; then
  tail -n 0 -f "$LOGFILE" &
  TAIL_PID=$!
fi

# Wait for PrismCast to exit.
wait $PRISMCAST_PID
EXIT_CODE=$?

# Clean up the tail process if it was started.
if [ -n "$TAIL_PID" ]; then
  kill $TAIL_PID 2>/dev/null || true
fi

exit $EXIT_CODE
