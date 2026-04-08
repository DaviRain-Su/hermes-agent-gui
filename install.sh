#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Hermes Agent GUI - User install script (no sudo required)
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Hermes Agent"
DESKTOP_FILE="dev.davirain.hermes-agent-gui.desktop"

APPS_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons"
INSTALL_DIR="${HOME}/.local/lib/hermes-agent-gui"

mkdir -p "${APPS_DIR}"
mkdir -p "${ICON_DIR}"
mkdir -p "${INSTALL_DIR}"

# Copy app files
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='src-tauri/target' \
    --exclude='build' \
    --exclude='*.inline.html' \
    "${SCRIPT_DIR}/" "${INSTALL_DIR}/"
else
  mkdir -p "${INSTALL_DIR}"
  for f in launcher.py install.sh src backend-service.ts package.json bun.lock README.md docs scripts python tests; do
    [ -e "${SCRIPT_DIR}/${f}" ] && cp -r "${SCRIPT_DIR}/${f}" "${INSTALL_DIR}/"
  done
fi

# Generate .desktop entry
cat > "${APPS_DIR}/${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Name=${APP_NAME}
Comment=Hermes Agent GUI
Exec=python3 ${INSTALL_DIR}/launcher.py
Icon=${ICON_DIR}/hermes-agent-gui.png
Type=Application
Terminal=false
Categories=Utility;
EOF

# Install a simple generic icon if none exists
if [ ! -f "${ICON_DIR}/hermes-agent-gui.png" ]; then
  # Use ImageMagick if available, otherwise copy a blank stub
  if command -v convert >/dev/null 2>&1; then
    convert -size 128x128 xc: '#3b82f6' -pointsize 60 -fill white -gravity center -annotate +0+0 'H' "${ICON_DIR}/hermes-agent-gui.png"
  else
    echo "Note: ImageMagick not found. Skipping icon generation."
  fi
fi

# Refresh desktop database if available
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${APPS_DIR}"
fi

echo "${APP_NAME} installed successfully."
echo "You can launch it from your applications menu or run:"
echo "  python3 ${INSTALL_DIR}/launcher.py"
