#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔨 Glove80 ZMK Firmware Compiler${NC}"
echo "=================================="
echo ""

# Configuration
CONFIG_PATH="$(pwd)/config"
OUT_PATH="$(pwd)/out"
FIRMWARE_PATH="$(pwd)/firmware"
DOCKER_IMAGE="zmkfirmware/zmk-build-arm:stable"
CONTAINER_NAME="glove80-zmk-compiler"

# Check for Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Docker is not installed!${NC}"
    echo "Install with: sudo pacman -S docker"
    exit 1
fi

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
    echo -e "${RED}Docker daemon is not running!${NC}"
    echo "Start with: sudo systemctl start docker"
    exit 1
fi

# Check if keymap.dtsi exists
if [ ! -f "$OUT_PATH/keymap.dtsi" ]; then
    echo -e "${RED}No keymap.dtsi found in out/ directory!${NC}"
    echo "Run: pnpm build"
    exit 1
fi

# Create directories
mkdir -p "$FIRMWARE_PATH"
mkdir -p "$CONFIG_PATH"

# Copy keymap.dtsi to config directory as glove80.keymap
echo -e "${YELLOW}Preparing keymap...${NC}"
cp "$OUT_PATH/keymap.dtsi" "$CONFIG_PATH/glove80.keymap"

# Create minimal glove80.conf if it doesn't exist
if [ ! -f "$CONFIG_PATH/glove80.conf" ]; then
    echo "# Glove80 Configuration" > "$CONFIG_PATH/glove80.conf"
    echo "CONFIG_ZMK_KEYBOARD_NAME=\"Glove80\"" >> "$CONFIG_PATH/glove80.conf"
fi

# Check if container exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}Found existing compiler container${NC}"
    # Start container if not running
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "Starting container..."
        docker start "$CONTAINER_NAME"
    fi
else
    echo -e "${YELLOW}Creating new compiler container...${NC}"
    # Create and start container
    docker run -d --name "$CONTAINER_NAME" \
        -v "$CONFIG_PATH":/config:ro \
        -v "$FIRMWARE_PATH":/firmware \
        "$DOCKER_IMAGE" \
        sleep infinity
fi

# Function to execute command in container
exec_in_container() {
    docker exec "$CONTAINER_NAME" bash -c "$1"
}

# Check if workspace is initialized with correct fork
echo -e "${BLUE}Checking workspace...${NC}"
WORKSPACE_EXISTS=$(exec_in_container "[ -d /tmp/zmk-workspace/zmk/.west ] && echo 'yes' || echo 'no'")
FORK_CORRECT=$(exec_in_container "cd /tmp/zmk-workspace/zmk 2>/dev/null && git remote -v | grep -q 'darknao' && echo 'yes' || echo 'no'")

if [ "$WORKSPACE_EXISTS" = "no" ] || [ "$FORK_CORRECT" = "no" ]; then
    if [ "$FORK_CORRECT" = "no" ]; then
        echo -e "${YELLOW}Wrong ZMK fork detected, reinitializing...${NC}"
    else
        echo -e "${YELLOW}Initializing ZMK workspace (5-15 minutes on first run)...${NC}"
    fi
    
    # Initialize workspace with darknao fork that supports RGB_STATUS and mouse features
    exec_in_container "cd /tmp && rm -rf zmk-workspace && mkdir -p zmk-workspace"
    exec_in_container "cd /tmp/zmk-workspace && git clone -b rgb-layer-24.12 --depth 1 https://github.com/darknao/zmk.git zmk"
    exec_in_container "cd /tmp/zmk-workspace && west init -l zmk/app"
    
    echo "Downloading dependencies..."
    exec_in_container "cd /tmp/zmk-workspace/zmk && west update"
    exec_in_container "cd /tmp/zmk-workspace/zmk && west zephyr-export"
    
    echo -e "${GREEN}✅ Workspace initialized with RGB/mouse support${NC}"
else
    echo -e "${GREEN}Using existing workspace with RGB/mouse support${NC}"
fi

# Build left half
echo ""
echo -e "${GREEN}Building left half...${NC}"
exec_in_container "cd /tmp/zmk-workspace/zmk && rm -rf build && \
    west build -p auto -b glove80_lh -d build -s app -- \
    -DZMK_CONFIG=/config \
    -DKEYMAP_FILE=/config/glove80.keymap"

# Copy left firmware
exec_in_container "cp /tmp/zmk-workspace/zmk/build/zephyr/zmk.uf2 /firmware/glove80_left.uf2"
echo -e "${GREEN}✅ Left half built${NC}"

# Build right half
echo ""
echo -e "${GREEN}Building right half...${NC}"
exec_in_container "cd /tmp/zmk-workspace/zmk && rm -rf build && \
    west build -p auto -b glove80_rh -d build -s app -- \
    -DZMK_CONFIG=/config \
    -DKEYMAP_FILE=/config/glove80.keymap"

# Copy right firmware
exec_in_container "cp /tmp/zmk-workspace/zmk/build/zephyr/zmk.uf2 /firmware/glove80_right.uf2"
echo -e "${GREEN}✅ Right half built${NC}"

# Summary
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Firmware compiled successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}Firmware files:${NC}"
ls -lh "$FIRMWARE_PATH"/*.uf2
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "1. Put keyboard half in bootloader mode (Magic + F1+F3+F5)"
echo "2. Copy firmware/glove80_left.uf2 to the mounted drive"
echo "3. Repeat for right half with glove80_right.uf2"
echo ""
echo -e "${YELLOW}Note: Container '$CONTAINER_NAME' is kept running for faster rebuilds${NC}"
echo "To stop it: docker stop $CONTAINER_NAME"