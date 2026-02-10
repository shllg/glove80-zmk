#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

FIRMWARE_PATH="$(pwd)/firmware"
MEDIA_BASE="/run/media/$(whoami)"

# Which firmware to flash (default: normal, can pass "settings-reset" as $1)
MODE="${1:-normal}"

if [ "$MODE" = "settings-reset" ]; then
  LEFT_UF2="$FIRMWARE_PATH/settings_reset_left.uf2"
  RIGHT_UF2="$FIRMWARE_PATH/settings_reset_right.uf2"
  LABEL="settings-reset"
else
  LEFT_UF2="$FIRMWARE_PATH/glove80_left.uf2"
  RIGHT_UF2="$FIRMWARE_PATH/glove80_right.uf2"
  LABEL="firmware"
fi

echo -e "${BLUE}${BOLD}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Glove80 Firmware Flash (${LABEL})"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${NC}"

# Verify firmware files exist
if [ ! -f "$LEFT_UF2" ]; then
  echo -e "${RED}Missing: $LEFT_UF2${NC}"
  echo "Run 'make compile' first (or 'make settings-reset' for reset firmware)."
  exit 1
fi
if [ ! -f "$RIGHT_UF2" ]; then
  echo -e "${RED}Missing: $RIGHT_UF2${NC}"
  echo "Run 'make compile' first (or 'make settings-reset' for reset firmware)."
  exit 1
fi

echo -e "${GREEN}Left:  $(basename "$LEFT_UF2") ($(du -h "$LEFT_UF2" | cut -f1))${NC}"
echo -e "${GREEN}Right: $(basename "$RIGHT_UF2") ($(du -h "$RIGHT_UF2" | cut -f1))${NC}"
echo ""

# Wait for a Glove80 bootloader device to appear
# Returns the mount path
wait_for_device() {
  local label="$1"
  local side="$2"
  local mount_path=""
  local elapsed=0
  local timeout=120

  while true; do
    if [ "$elapsed" -ge "$timeout" ]; then
      echo ""
      echo -e "${RED}Timeout: ${label} did not appear within ${timeout} seconds.${NC}" >&2
      echo -e "Make sure the ${side} half is in bootloader mode." >&2
      exit 1
    fi

    # Check if already mounted
    mount_path="$MEDIA_BASE/$label"
    if [ -d "$mount_path" ] && [ -f "$mount_path/INFO_UF2.TXT" ]; then
      echo "$mount_path"
      return 0
    fi

    # Also check via lsblk for the label in case mount path differs
    local dev
    dev=$(lsblk -o NAME,LABEL -rn 2>/dev/null | grep "$label" | awk '{print $1}' || true)
    if [ -n "$dev" ]; then
      # Try to find its mount point
      mount_path=$(lsblk -o MOUNTPOINT -rn "/dev/$dev" 2>/dev/null | head -1 || true)
      if [ -z "$mount_path" ]; then
        # Not mounted yet, try to mount via udisksctl
        udisksctl mount -b "/dev/$dev" --no-user-interaction >/dev/null 2>/dev/null || true
        sleep 1
        mount_path=$(lsblk -o MOUNTPOINT -rn "/dev/$dev" 2>/dev/null | head -1 || true)
      fi
      if [ -n "$mount_path" ] && [ -d "$mount_path" ]; then
        echo "$mount_path"
        return 0
      fi
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done
}

# Wait for device to disappear (flash complete)
wait_for_disconnect() {
  local mount_path="$1"
  local label="$2"
  local elapsed=0
  local timeout=120

  while true; do
    if [ "$elapsed" -ge "$timeout" ]; then
      echo ""
      echo -e "${RED}Timeout: ${label} did not disconnect within ${timeout} seconds.${NC}" >&2
      echo -e "The flash may have failed. Try again." >&2
      exit 1
    fi

    # Check if mount path is gone
    if [ ! -d "$mount_path" ]; then
      return 0
    fi
    # Also check if lsblk no longer shows the label
    if ! lsblk -o LABEL -rn 2>/dev/null | grep -q "$label"; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

flash_half() {
  local side="$1"
  local label="$2"
  local uf2="$3"
  local step="$4"

  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}Step ${step}: Flash ${side} half${NC}"
  echo ""
  echo -e "${YELLOW}Put the ${side} half into bootloader mode:${NC}"
  echo ""
  echo -e "  ${BOLD}Option A — Power-up method (always works):${NC}"
  echo -e "    1. Switch off the power switch"
  echo -e "    2. Connect USB cable from computer to the ${side,,} half"
  if [ "$side" = "Left" ]; then
    echo -e "    3. Hold ${BOLD}Magic + E${NC} (C6R6 + C3R3)"
  else
    echo -e "    3. Hold ${BOLD}I + PgDn${NC} (C6R6 + C3R3)"
  fi
  echo -e "    4. While holding, switch on the power switch"
  echo ""
  echo -e "  ${BOLD}Option B — From ZMK (requires working firmware):${NC}"
  if [ "$side" = "Left" ]; then
    echo -e "    Press ${BOLD}Magic + Esc${NC}"
  else
    echo -e "    Press ${BOLD}Magic + '${NC}"
  fi
  echo ""
  echo -e "  ${BOLD}Success:${NC} slow pulsing red LED next to the power switch"
  echo ""
  echo -ne "${BLUE}Waiting for ${label} to appear...${NC}"

  local mount_path
  mount_path=$(wait_for_device "$label" "$side")

  echo -e "\r${GREEN}Found ${label} at ${mount_path}                    ${NC}"
  echo -ne "${BLUE}Copying $(basename "$uf2")...${NC}"

  cp "$uf2" "$mount_path/"

  echo -e "\r${GREEN}Copied $(basename "$uf2") to ${mount_path}${NC}"
  echo -ne "${BLUE}Waiting for flash to complete...${NC}"

  wait_for_disconnect "$mount_path" "$label"

  echo -e "\r${GREEN}${BOLD}${side} half flashed successfully!${NC}                    "
  echo ""
}

# Flash left half
flash_half "Left" "GLV80LHBOOT" "$LEFT_UF2" "1"

# Flash right half
flash_half "Right" "GLV80RHBOOT" "$RIGHT_UF2" "2"

# Done
echo -e "${GREEN}${BOLD}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Done! Both halves flashed."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${NC}"
echo -e "Power on both halves simultaneously to re-pair."

if [ "$MODE" = "settings-reset" ]; then
  echo ""
  echo -e "${YELLOW}${BOLD}Next: flash the normal firmware!${NC}"
  echo -e "Run: ${BOLD}make flash${NC}"
fi
