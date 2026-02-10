# Glove80 ZMK Keymap Generator
# Builds keymap configs, diagrams, and firmware from layout.json

# Set default shell
SHELL := /bin/bash

# Colors for output
CYAN := \033[0;36m
GREEN := \033[0;32m
YELLOW := \033[1;33m
RESET := \033[0m

# Help target (default)
.PHONY: help
help:
	@echo "Glove80 ZMK Keymap Generator"
	@echo ""
	@echo "Usage:"
	@echo "  make build          # Generate keymap files (dtsi, yaml, svg, pdf)"
	@echo "  make compile        # Compile firmware to UF2 (requires Docker)"
	@echo "  make flash          # Interactive guided flash to both halves"
	@echo "  make draw           # Generate SVG diagram from YAML"
	@echo "  make pdf            # Generate multi-page PDF from SVG"
	@echo "  make install        # Install project dependencies"
	@echo ""
	@echo "Combined targets:"
	@echo "  make all            # Build keymap + compile firmware"
	@echo "  make ship           # Build + compile + flash (full pipeline)"
	@echo "  make diagrams       # Generate both SVG and PDF diagrams"
	@echo "  make clean-compile  # Destroy Docker container + recompile from scratch"
	@echo ""
	@echo "Troubleshooting:"
	@echo "  make settings-reset # Build settings-reset firmware (clears persistent storage)"
	@echo "  make flash-reset    # Flash settings-reset firmware to both halves"
	@echo ""
	@echo "Output files:"
	@echo "  out/keymap.dtsi     # ZMK device tree overlay"
	@echo "  out/keymap.yaml     # keymap-drawer YAML"
	@echo "  out/keymap.svg      # SVG diagram"
	@echo "  out/keymap.pdf      # Multi-page PDF diagram"
	@echo "  ~/glove80-mapping.pdf  # Copy of PDF for quick access"

# Install dependencies
.PHONY: install
install:
	@echo -e "$(CYAN)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(RESET)"
	@echo -e "$(GREEN)Installing dependencies...$(RESET)"
	@pnpm install
	@echo -e "$(GREEN)✓ Dependencies installed$(RESET)"
	@echo ""

# Build keymap (generates dtsi, yaml, svg, pdf)
.PHONY: build
build:
	@echo -e "$(CYAN)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(RESET)"
	@echo -e "$(GREEN)Building keymap...$(RESET)"
	@pnpm build
	@echo -e "$(GREEN)✓ Keymap built successfully$(RESET)"
	@echo ""

# Generate SVG diagram
.PHONY: draw
draw:
	@echo -e "$(CYAN)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(RESET)"
	@echo -e "$(GREEN)Generating SVG diagram...$(RESET)"
	@keymap draw out/keymap.yaml --output out/keymap.svg
	@echo -e "$(GREEN)✓ SVG diagram generated: out/keymap.svg$(RESET)"
	@echo ""

# Generate multi-page PDF
.PHONY: pdf
pdf:
	@echo -e "$(CYAN)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(RESET)"
	@echo -e "$(GREEN)Generating PDF...$(RESET)"
	@./scripts/generate-pdf.sh
	@echo -e "$(GREEN)✓ PDF generated: out/keymap.pdf → ~/glove80-mapping.pdf$(RESET)"
	@echo ""

# Compile firmware (requires Docker)
.PHONY: compile
compile:
	@echo -e "$(CYAN)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(RESET)"
	@echo -e "$(GREEN)Compiling firmware...$(RESET)"
	@./scripts/compile.sh
	@echo -e "$(GREEN)✓ Firmware compiled$(RESET)"
	@echo ""

# Flash firmware to both halves (interactive, guided)
.PHONY: flash
flash:
	@./scripts/flash.sh

# Flash settings-reset firmware to both halves (builds if needed)
.PHONY: flash-reset
flash-reset: settings-reset
	@./scripts/flash.sh settings-reset

# Verify build output integrity
.PHONY: verify
verify:
	@echo -e "$(CYAN)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(RESET)"
	@echo -e "$(GREEN)Verifying build output...$(RESET)"
	@./scripts/verify-build.sh
	@echo ""

# Combined: build + compile
.PHONY: all
all: build compile

# Full pipeline: build + compile + flash
.PHONY: ship
ship: build compile flash

# Clean compile: destroy Docker container and rebuild from scratch
# Use this after changing ZMK fork/branch or when the build environment is stale
.PHONY: clean-compile
clean-compile:
	@echo -e "$(CYAN)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(RESET)"
	@echo -e "$(YELLOW)Removing compiler container for clean rebuild...$(RESET)"
	@docker stop glove80-zmk-compiler 2>/dev/null || true
	@docker rm glove80-zmk-compiler 2>/dev/null || true
	@echo -e "$(GREEN)✓ Container removed$(RESET)"
	@echo ""
	@$(MAKE) compile

# Combined: draw + pdf
.PHONY: diagrams
diagrams: draw pdf

# Build settings-reset firmware (clears all persistent storage on keyboard)
# Flash this to BOTH halves before re-flashing normal firmware
.PHONY: settings-reset
settings-reset:
	@echo -e "$(CYAN)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(RESET)"
	@echo -e "$(YELLOW)Building settings-reset firmware...$(RESET)"
	@echo -e "$(YELLOW)This clears ALL persistent storage (BLE bonds, RGB state, etc.)$(RESET)"
	@echo ""
	@mkdir -p firmware
	@CONTAINER_NAME="glove80-zmk-compiler"; \
	if ! docker ps --format '{{.Names}}' | grep -q "^$${CONTAINER_NAME}$$"; then \
		echo -e "$(YELLOW)Compiler container not running. Run 'make compile' first to set up the build environment.$(RESET)"; \
		exit 1; \
	fi; \
	echo -e "$(YELLOW)Using official MoErgo ZMK for settings-reset build...$(RESET)"; \
	docker exec $$CONTAINER_NAME bash -c "[ -d /tmp/zmk-reset-workspace/zmk/.west ]" 2>/dev/null || ( \
		echo "Initializing official MoErgo ZMK workspace (one-time)..."; \
		docker exec $$CONTAINER_NAME bash -c "rm -rf /tmp/zmk-reset-workspace && mkdir -p /tmp/zmk-reset-workspace"; \
		docker exec $$CONTAINER_NAME bash -c "cd /tmp/zmk-reset-workspace && git clone --depth 1 https://github.com/moergo-sc/zmk.git zmk && cd zmk && git fetch --depth 1 origin 11454d23596afbdb06380a1125371b19ab65675c && git checkout 11454d23596afbdb06380a1125371b19ab65675c"; \
		docker exec $$CONTAINER_NAME bash -c "cd /tmp/zmk-reset-workspace && west init -l zmk/app"; \
		docker exec $$CONTAINER_NAME bash -c "cd /tmp/zmk-reset-workspace/zmk && west update"; \
		docker exec $$CONTAINER_NAME bash -c "cd /tmp/zmk-reset-workspace/zmk && west zephyr-export"; \
	); \
	echo -e "$(GREEN)Building settings-reset for left half...$(RESET)"; \
	docker exec $$CONTAINER_NAME bash -c "cd /tmp/zmk-reset-workspace/zmk && rm -rf build && \
		west build -p auto -b glove80_lh -d build -s app -- \
		-DSHIELD=settings_reset"; \
	docker exec $$CONTAINER_NAME bash -c "cp /tmp/zmk-reset-workspace/zmk/build/zephyr/zmk.uf2 /firmware/settings_reset_left.uf2"; \
	echo -e "$(GREEN)Building settings-reset for right half...$(RESET)"; \
	docker exec $$CONTAINER_NAME bash -c "cd /tmp/zmk-reset-workspace/zmk && rm -rf build && \
		west build -p auto -b glove80_rh -d build -s app -- \
		-DSHIELD=settings_reset"; \
	docker exec $$CONTAINER_NAME bash -c "cp /tmp/zmk-reset-workspace/zmk/build/zephyr/zmk.uf2 /firmware/settings_reset_right.uf2"
	@echo ""
	@echo -e "$(GREEN)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(RESET)"
	@echo -e "$(GREEN)Settings-reset firmware built:$(RESET)"
	@ls -lh firmware/settings_reset_*.uf2
	@echo ""
	@echo -e "$(YELLOW)Flash procedure:$(RESET)"
	@echo "  1. Flash settings_reset_left.uf2 to left half (bootloader mode)"
	@echo "  2. Flash settings_reset_right.uf2 to right half (bootloader mode)"
	@echo "  3. Re-flash normal firmware to both halves (make compile first)"
	@echo "  4. Power on both halves simultaneously to re-pair"
