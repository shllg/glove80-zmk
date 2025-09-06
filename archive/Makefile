# Glove80 ZMK Firmware Makefile
# Quick access to common commands

.PHONY: help build clean flash setup docker-check

# Default target
help:
	@echo "Glove80 ZMK Firmware Build System"
	@echo "================================="
	@echo ""
	@echo "Main commands:"
	@echo "  make build       - Build firmware for both halves"
	@echo "  make clean       - Clean firmware outputs"
	@echo "  make clean-all   - Full clean (removes Docker container)"
	@echo "  make flash       - Flash firmware to keyboard"
	@echo ""
	@echo "Quick workflow:"
	@echo "  1. Edit keymap: make edit-keymap"
	@echo "  2. Build firmware: make build"
	@echo "  3. Flash keyboard: make flash"
	@echo ""
	@echo "Container management:"
	@echo "  make container-status - Check Docker container status"
	@echo "  make container-stop   - Stop the builder container"
	@echo "  make container-start  - Start the builder container"
	@echo ""
	@echo "Development:"
	@echo "  make edit-keymap - Edit main keymap"
	@echo "  make edit-conf   - Edit configuration"
	@echo "  make status      - Check project status"
	@echo "  make keymap      - Show visual keymap layout"
	@echo "  make monitor     - Monitor USB for keyboard"

# Build firmware
build: docker-check
	@echo "🔨 Building firmware..."
	@./scripts/build.sh

# Clean build outputs only
clean:
	@echo "🧹 Cleaning build directory..."
	@rm -rf build firmware/*.uf2

# Clean everything including cache and Docker container
clean-all: docker-check
	@echo "🧹 Full clean (build + cache + container)..."
	@rm -rf build firmware/*.uf2
	@docker stop glove80-zmk-builder 2>/dev/null || true
	@docker rm glove80-zmk-builder 2>/dev/null || true
	@echo "✅ Clean complete"

# Flash firmware
flash:
	@echo "⚡ Starting flash process..."
	@./scripts/flash.sh

# Setup and checks
setup: docker-check
	@echo "🔧 Checking environment..."
	@command -v docker >/dev/null 2>&1 || { echo "❌ Docker not installed. Please install Docker first."; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "❌ Docker daemon not running. Start with: sudo systemctl start docker"; exit 1; }
	@echo "✅ Docker is ready"
	@echo ""
	@if [ -f firmware/glove80_left.uf2 ] && [ -f firmware/glove80_right.uf2 ]; then \
		echo "✅ Firmware files exist"; \
		ls -lh firmware/*.uf2; \
	else \
		echo "⚠️  No firmware built yet. Run 'make build'"; \
	fi

# Docker check
docker-check:
	@command -v docker >/dev/null 2>&1 || { echo "❌ Docker not installed. Run 'make setup' for details."; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "❌ Docker daemon not running. Start with: sudo systemctl start docker"; exit 1; }

# Status check
status:
	@echo "📊 Project Status"
	@echo "================"
	@echo ""
	@echo "Main Keymap:"
	@if [ -f config/glove80.keymap ]; then \
		echo "  ✅ Found: config/glove80.keymap"; \
		echo "  📅 Modified: $$(stat -c %y config/glove80.keymap | cut -d' ' -f1,2)"; \
	else \
		echo "  ❌ Not found"; \
	fi
	@echo ""
	@echo "Firmware:"
	@if [ -f firmware/glove80_left.uf2 ]; then \
		echo "  ✅ Left:  $$(ls -lh firmware/glove80_left.uf2 | awk '{print $$5}')"; \
		echo "  📅 Built: $$(stat -c %y firmware/glove80_left.uf2 | cut -d' ' -f1,2)"; \
	else \
		echo "  ❌ Left:  Not built"; \
	fi
	@if [ -f firmware/glove80_right.uf2 ]; then \
		echo "  ✅ Right: $$(ls -lh firmware/glove80_right.uf2 | awk '{print $$5}')"; \
		echo "  📅 Built: $$(stat -c %y firmware/glove80_right.uf2 | cut -d' ' -f1,2)"; \
	else \
		echo "  ❌ Right: Not built"; \
	fi
	@echo ""
	@echo "Docker:"
	@if docker info >/dev/null 2>&1; then \
		echo "  ✅ Running"; \
	else \
		echo "  ❌ Not running"; \
	fi

# Edit shortcuts
edit-keymap:
	@$${EDITOR:-nano} config/glove80.keymap

edit-conf:
	@$${EDITOR:-nano} config/glove80.conf

edit-hrm:
	@$${EDITOR:-nano} config/includes/behaviors.dtsi

edit-combos:
	@$${EDITOR:-nano} config/includes/combos.dtsi

edit-macros:
	@$${EDITOR:-nano} config/includes/macros.dtsi

edit-claude:
	@$${EDITOR:-nano} CLAUDE.md

# View logs
logs:
	@if [ -d build/left ]; then \
		echo "=== Left Half Build Log ==="; \
		tail -n 50 build/left/build.log 2>/dev/null || echo "No build log found"; \
		echo ""; \
	fi
	@if [ -d build/right ]; then \
		echo "=== Right Half Build Log ==="; \
		tail -n 50 build/right/build.log 2>/dev/null || echo "No build log found"; \
	fi

# Quick rebuild (no clean)
quick: docker-check
	@echo "⚡ Quick rebuild..."
	@./scripts/build.sh

# Install Docker (Arch Linux)
install-docker:
	@echo "📦 Installing Docker on Arch Linux..."
	sudo pacman -S docker
	sudo systemctl enable docker
	sudo systemctl start docker
	sudo usermod -aG docker $$USER
	@echo "✅ Docker installed. Please log out and back in for group changes to take effect."

# Pull Docker image
pull-image:
	@echo "📥 Pulling ZMK Docker image..."
	docker pull zmkfirmware/zmk-build-arm:stable

# Container management
container-stop:
	@echo "⏹️  Stopping builder container..."
	@docker stop glove80-zmk-builder 2>/dev/null && echo "✅ Container stopped" || echo "Container not running"

container-start:
	@echo "▶️  Starting builder container..."
	@docker start glove80-zmk-builder 2>/dev/null && echo "✅ Container started" || echo "Container doesn't exist"

container-status:
	@echo "📊 Container status:"
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Size}}" | grep -E "NAME|glove80" || echo "No container found"

# Backup current config
backup:
	@echo "💾 Backing up configuration..."
	@mkdir -p backups
	@TIMESTAMP=$$(date +%Y%m%d_%H%M%S); \
	tar -czf backups/glove80_config_$$TIMESTAMP.tar.gz config/
	@echo "✅ Backup saved to backups/"
	@ls -lh backups/ | tail -5

# Validate configuration files
validate:
	@echo "🔍 Validating configuration files..."
	@for file in config/glove80.keymap config/includes/*.dtsi; do \
		if [ -f $$file ]; then \
			echo -n "  Checking $$file... "; \
			if grep -q "^#include" $$file && grep -q "^/" $$file; then \
				echo "✅"; \
			else \
				echo "⚠️  (might be incomplete)"; \
			fi \
		fi \
	done

# Monitor keyboard USB connection
monitor:
	@echo "👀 Monitoring USB devices (Ctrl+C to stop)..."
	@echo "Looking for Glove80 devices..."
	@watch -n 1 'echo "=== Connected Glove80 Devices ==="; \
		lsusb | grep -E "16[Cc]0:(27[Dd][9BbDd])" | while read line; do \
			if echo "$$line" | grep -q "27d9"; then \
				echo "✅ $$line (Left Half)"; \
			elif echo "$$line" | grep -q "27db"; then \
				echo "✅ $$line (Right Half)"; \
			elif echo "$$line" | grep -q "27dd"; then \
				echo "⚡ $$line (BOOTLOADER MODE)"; \
			else \
				echo "🔌 $$line"; \
			fi \
		done || echo "❌ No Glove80 detected"; \
		echo ""; \
		echo "Normal: 16c0:27d9 (L) / 16c0:27db (R)"; \
		echo "Bootloader: 16c0:27dd"'

# Clean firmware outputs only
clean-firmware:
	@echo "🧹 Cleaning firmware outputs..."
	@rm -rf firmware/*.uf2

# Show key positions reference
keys:
	@echo "Glove80 Key Position Reference"
	@echo "==============================="
	@echo ""
	@echo "Left Hand:            Right Hand:"
	@echo "0  1  2  3  4        5  6  7  8  9"
	@echo "10 11 12 13 14      15 16 17 18 19"
	@echo "20 21 22 23 24      25 26 27 28 29"
	@echo "30 31 32 33 34      35 36 37 38 39"
	@echo "40 41 42 43 44      45 46 47 48 49"
	@echo "   50 51 52            53 54 55"
	@echo "   56 57 58            59 60 61"
	@echo "   62 63 64            65 66 67"
	@echo "   68 69                70 71"
	@echo "   72 73                74 75"
	@echo "   76 77                78 79"

# Show visual keymap layout
keymap: 
	@./scripts/show_keymap.py || (echo "❌ Python required. Install with: sudo pacman -S python"; exit 1)

# Export keymap to JSON
keymap-json:
	@echo "📦 Exporting keymap to JSON..."
	@./scripts/export_keymap_json.py
	@echo "✅ Exported to keymap.json and keymap.min.json"

# Show visual keymap for specific layer
keymap-layer:
	@read -p "Enter layer number (0=Base, 1=Lower, 2=Magic): " layer; \
	./scripts/show_keymap.py $$layer

.SILENT: help status keys