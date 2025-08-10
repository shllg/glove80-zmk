#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Paths
WEB_IMPORT_DIR="config/web_import"
WEB_KEYMAP="$WEB_IMPORT_DIR/glove80_web.keymap"
MAIN_KEYMAP="config/glove80.keymap"
BACKUP_DIR="$WEB_IMPORT_DIR/backups"

echo -e "${BLUE}Glove80 Web Interface Import Tool${NC}"
echo "=================================="
echo ""

# Check if web keymap exists
if [ ! -f "$WEB_KEYMAP" ]; then
    echo -e "${YELLOW}No web interface export found!${NC}"
    echo ""
    echo "Instructions:"
    echo "1. Go to https://my.glove80.com"
    echo "2. Configure your layout"
    echo "3. Export the keymap"
    echo "4. Save it as: $WEB_KEYMAP"
    echo ""
    exit 1
fi

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Backup existing files
if [ -f "$MAIN_KEYMAP" ]; then
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    echo -e "${YELLOW}Backing up existing keymap...${NC}"
    cp "$MAIN_KEYMAP" "$BACKUP_DIR/glove80_${TIMESTAMP}.keymap"
    echo -e "${GREEN}Backup saved to: $BACKUP_DIR/glove80_${TIMESTAMP}.keymap${NC}"
fi

# Show diff if main keymap exists
if [ -f "$MAIN_KEYMAP" ]; then
    echo ""
    echo -e "${BLUE}Changes from web interface:${NC}"
    echo "----------------------------"
    if diff -u "$MAIN_KEYMAP" "$WEB_KEYMAP" > /dev/null 2>&1; then
        echo "No changes detected."
    else
        # Show simplified diff
        diff -u "$MAIN_KEYMAP" "$WEB_KEYMAP" | head -50 || true
        echo ""
        echo -e "${YELLOW}... (showing first 50 lines of diff)${NC}"
    fi
    echo ""
fi

# Ask for confirmation
read -p "Import web interface keymap? This will update your main keymap. (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Import cancelled.${NC}"
    exit 1
fi

# Create migration script if it doesn't exist
MIGRATION_SCRIPT="$WEB_IMPORT_DIR/migration.sh"
if [ ! -f "$MIGRATION_SCRIPT" ]; then
    cat > "$MIGRATION_SCRIPT" << 'EOF'
#!/bin/bash
# Custom migration rules
# Add your custom transformations here

# Example: Add custom includes after the standard includes
sed -i '/#include <dt-bindings\/zmk\/outputs.h>/a\
\
// Custom includes\
#include "includes/behaviors.dtsi"\
#include "includes/combos.dtsi"\
#include "includes/macros.dtsi"' "$1"

# Example: Replace specific key bindings
# sed -i 's/&kp LCTRL/&hml LCTRL/g' "$1"

echo "Custom migrations applied."
EOF
    chmod +x "$MIGRATION_SCRIPT"
    echo -e "${GREEN}Created migration script: $MIGRATION_SCRIPT${NC}"
fi

# Copy web keymap to main location
cp "$WEB_KEYMAP" "$MAIN_KEYMAP"
echo -e "${GREEN}Imported web keymap to: $MAIN_KEYMAP${NC}"

# Run migration script
if [ -x "$MIGRATION_SCRIPT" ]; then
    echo -e "${BLUE}Running migration script...${NC}"
    "$MIGRATION_SCRIPT" "$MAIN_KEYMAP"
fi

echo ""
echo -e "${GREEN}✅ Import complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Review the imported keymap: $MAIN_KEYMAP"
echo "2. Edit migration rules if needed: $MIGRATION_SCRIPT"
echo "3. Build firmware: ./scripts/build.sh"