#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}⚡ Glove80 Firmware Flash Tool${NC}"
echo "================================"
echo ""

FIRMWARE_PATH="$(pwd)/firmware"

# Check if firmware files exist
if [ ! -f "$FIRMWARE_PATH/glove80_left.uf2" ] || [ ! -f "$FIRMWARE_PATH/glove80_right.uf2" ]; then
    echo -e "${RED}Firmware files not found!${NC}"
    echo "Please build the firmware first:"
    echo "  ./scripts/build.sh"
    exit 1
fi

echo -e "${BLUE}Firmware files found:${NC}"
ls -lh "$FIRMWARE_PATH"/*.uf2
echo ""

echo -e "${YELLOW}Instructions:${NC}"
echo "1. Connect ONE keyboard half via USB"
echo "2. Enter bootloader mode:"
echo "   - Hold the innermost thumb key (closest to USB) while plugging in"
echo "   - OR press the physical reset button on the PCB"
echo "3. A drive named 'GLV80LHBOOT' (left) or 'GLV80RHBOOT' (right) will appear"
echo "4. The script will detect and flash automatically"
echo ""

# Function to detect and flash
flash_keyboard() {
    local MOUNT_POINT=""
    local SIDE=""
    local FIRMWARE=""
    
    # Check common mount points
    for MP in /media/$USER/GLV80LHBOOT /media/$USER/GLV80RHBOOT \
              /mnt/GLV80LHBOOT /mnt/GLV80RHBOOT \
              /run/media/$USER/GLV80LHBOOT /run/media/$USER/GLV80RHBOOT; do
        if [ -d "$MP" ]; then
            MOUNT_POINT="$MP"
            if [[ "$MP" == *"LHBOOT"* ]]; then
                SIDE="left"
                FIRMWARE="$FIRMWARE_PATH/glove80_left.uf2"
            else
                SIDE="right"
                FIRMWARE="$FIRMWARE_PATH/glove80_right.uf2"
            fi
            break
        fi
    done
    
    if [ -z "$MOUNT_POINT" ]; then
        return 1
    fi
    
    echo -e "${GREEN}✅ Detected $SIDE keyboard in bootloader mode${NC}"
    echo "Mount point: $MOUNT_POINT"
    echo ""
    
    read -p "Flash $SIDE firmware? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}Flashing $SIDE firmware...${NC}"
        cp "$FIRMWARE" "$MOUNT_POINT/"
        sync
        echo -e "${GREEN}✅ $SIDE firmware flashed successfully!${NC}"
        echo "The keyboard will restart automatically."
        return 0
    else
        echo -e "${YELLOW}Skipped flashing $SIDE firmware${NC}"
        return 2
    fi
}

# Main loop
echo -e "${CYAN}Waiting for keyboard in bootloader mode...${NC}"
echo "(Press Ctrl+C to exit)"
echo ""

FLASHED_LEFT=false
FLASHED_RIGHT=false

while true; do
    if flash_keyboard; then
        if [[ "$SIDE" == "left" ]]; then
            FLASHED_LEFT=true
        else
            FLASHED_RIGHT=true
        fi
        
        echo ""
        if [ "$FLASHED_LEFT" = true ] && [ "$FLASHED_RIGHT" = true ]; then
            echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo -e "${GREEN}✅ Both halves flashed successfully!${NC}"
            echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo ""
            echo "Your Glove80 is ready to use!"
            exit 0
        else
            echo -e "${YELLOW}Status:${NC}"
            [ "$FLASHED_LEFT" = true ] && echo "  Left: ✅ Flashed" || echo "  Left: ⏳ Waiting"
            [ "$FLASHED_RIGHT" = true ] && echo "  Right: ✅ Flashed" || echo "  Right: ⏳ Waiting"
            echo ""
            echo "Please connect and flash the other half..."
            echo ""
        fi
        
        # Wait for device to disconnect
        sleep 3
    fi
    
    # Check every second
    sleep 1
done