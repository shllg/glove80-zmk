#!/bin/bash
set -euo pipefail

# Verify build output integrity
# Checks that generated files have no unreplaced placeholders
# and contain expected structural elements

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

DTSI="out/keymap.dtsi"
YAML="out/keymap.yaml"
ERRORS=0

if [ ! -f "$DTSI" ]; then
  echo -e "${RED}FAIL: $DTSI does not exist${NC}"
  exit 1
fi

if [ ! -f "$YAML" ]; then
  echo -e "${RED}FAIL: $YAML does not exist${NC}"
  exit 1
fi

# Check for unreplaced placeholders
if grep -q 'PLACEHOLDER_' "$DTSI"; then
  echo -e "${RED}FAIL: Found unreplaced PLACEHOLDER_ in $DTSI:${NC}"
  grep 'PLACEHOLDER_' "$DTSI"
  ERRORS=$((ERRORS + 1))
fi

# Check that layer defines exist
if ! grep -q '#define LAYER_Base' "$DTSI"; then
  echo -e "${RED}FAIL: Missing layer defines in $DTSI${NC}"
  ERRORS=$((ERRORS + 1))
fi

# Check that keymap section exists
if ! grep -q 'compatible = "zmk,keymap"' "$DTSI"; then
  echo -e "${RED}FAIL: Missing keymap section in $DTSI${NC}"
  ERRORS=$((ERRORS + 1))
fi

# Check that YAML has layers
if ! grep -q '^layers:' "$YAML"; then
  echo -e "${RED}FAIL: Missing layers section in $YAML${NC}"
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}$ERRORS check(s) failed${NC}"
  exit 1
fi

echo -e "${GREEN}All build verification checks passed${NC}"
