#!/bin/bash

# Generate multi-page PDF with layers split across pages
# Usage: ./scripts/generate-multipage-pdf.sh

set -e

echo "Generating multi-page PDF..."

# Create temp directory for individual PDFs
TEMP_DIR="out/temp_pdf"
mkdir -p "$TEMP_DIR"

# Clean up previous temp files
rm -f "$TEMP_DIR"/*.yaml "$TEMP_DIR"/*.svg "$TEMP_DIR"/*.pdf

# Read the main YAML file
MAIN_YAML="out/keymap.yaml"

# Function to extract layers and create separate YAML files
create_layer_group() {
    local group_name=$1
    shift
    local layers=("$@")
    
    echo "Creating group: $group_name with layers: ${layers[*]}"
    
    # Start building the YAML
    cat > "$TEMP_DIR/${group_name}.yaml" << 'EOF'
layout:
  zmk_keyboard: glove80
draw_config:
  n_columns: 1
  footer_text: "LED colors configured for underglow"
  svg_extra_style: |
EOF
    
    # Copy the CSS styles from main YAML
    awk '/svg_extra_style:/{flag=1; next} /^layers:/{flag=0} flag && /^    /' "$MAIN_YAML" >> "$TEMP_DIR/${group_name}.yaml"
    
    echo "layers:" >> "$TEMP_DIR/${group_name}.yaml"
    
    # Extract specified layers
    for layer in "${layers[@]}"; do
        echo "  Extracting layer: $layer"
        # Extract the layer section from the main YAML
        # Use a more robust extraction that handles quoted strings properly
        python3 -c "
import yaml
import sys

with open('$MAIN_YAML', 'r') as f:
    data = yaml.safe_load(f)
    
if 'layers' in data and '$layer' in data['layers']:
    layer_data = {'$layer': data['layers']['$layer']}
    yaml.dump(layer_data, sys.stdout, default_flow_style=False, allow_unicode=True, width=1000)
" | sed 's/^/  /' >> "$TEMP_DIR/${group_name}.yaml"
    done
    
    # Generate SVG for this group
    keymap draw "$TEMP_DIR/${group_name}.yaml" --output "$TEMP_DIR/${group_name}.svg"
    
    # Convert to PDF
    inkscape "$TEMP_DIR/${group_name}.svg" --export-type=pdf --export-filename="$TEMP_DIR/${group_name}.pdf" 2>/dev/null
}

# Create page 1: Base, Navigation, Chars
create_layer_group "page1" "Base" "Navigation" "Chars"

# Create page 2: Special, Media, Magic  
create_layer_group "page2" "Special" "Media" "Magic"

# Combine PDFs into single multi-page document
# Using ghostscript (gs) or pdfunite if available
if command -v pdfunite &> /dev/null; then
    echo "Combining PDFs with pdfunite..."
    pdfunite "$TEMP_DIR"/page*.pdf "out/keymap.pdf"
elif command -v gs &> /dev/null; then
    echo "Combining PDFs with ghostscript..."
    gs -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite -sOutputFile="out/keymap.pdf" "$TEMP_DIR"/page*.pdf
else
    echo "Warning: Neither pdfunite nor ghostscript found. Individual PDFs are in $TEMP_DIR/"
    echo "Install poppler-utils (for pdfunite) or ghostscript to combine PDFs automatically."
    exit 1
fi

echo "✅ Multi-page PDF generated: out/keymap.pdf"

# Optional: clean up temp files
# rm -rf "$TEMP_DIR"