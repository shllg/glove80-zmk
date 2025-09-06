#!/usr/bin/env python3
"""
Generate an HTML visualization of the Glove80 keyboard layout from the keymap file.
"""

import re
import json
from pathlib import Path

# Glove80 actual physical layout - 80 keys total
# The actual Glove80 has an integrated thumb cluster design
GLOVE80_LAYOUT = {
    'left': [
        # Row 0: F-keys (5 keys on left) - positions 0-4
        [0, 1, 2, 3, 4],
        # Row 1: Number row (6 keys) - positions 10-15
        [10, 11, 12, 13, 14, 15],
        # Row 2: QWERTY top row (6 keys) - positions 22-27
        [22, 23, 24, 25, 26, 27],
        # Row 3: Home row (6 keys) - positions 34-39
        [34, 35, 36, 37, 38, 39],
        # Row 4: Bottom row (7 keys including lower) - positions 46-52
        [46, 47, 48, 49, 50, 51, 52],
        # Row 5: Navigation row (5 keys) - positions 64-68
        [64, 65, 66, 67, 68],
        # Thumb cluster row - positions 69-71
        [None, None, None, 69, 70, 71]
    ],
    'right': [
        # Row 0: F-keys (5 keys on right) - positions 5-9
        [5, 6, 7, 8, 9],
        # Row 1: Number row (6 keys) - positions 16-21
        [16, 17, 18, 19, 20, 21],
        # Row 2: QWERTY top row (6 keys) - positions 28-33
        [28, 29, 30, 31, 32, 33],
        # Row 3: Home row (6 keys) - positions 40-45
        [40, 41, 42, 43, 44, 45],
        # Row 4: Bottom row (6 keys) - positions 58-63
        [58, 59, 60, 61, 62, 63],
        # Row 5: Navigation row (5 keys) - positions 75-79
        [75, 76, 77, 78, 79],
        # Thumb cluster row - positions 72-74
        [72, 73, 74, None, None, None]
    ],
    'center': [
        # Center modifier keys - positions 53-57
        [53, 54, 55, 56, 57]
    ]
}

def parse_keymap(keymap_path):
    """Parse the ZMK keymap file and extract layers."""
    with open(keymap_path, 'r') as f:
        content = f.read()
    
    # Find the keymap block
    keymap_match = re.search(r'keymap\s*\{.*?compatible\s*=\s*"zmk,keymap";\s*(.*?)\s*\};', 
                            content, re.DOTALL)
    if not keymap_match:
        raise ValueError("Could not find keymap in file")
    
    keymap_content = keymap_match.group(1)
    
    # Find all layers with multiline bindings
    # The bindings end with >; and the layer ends with };
    layer_pattern = r'layer_(\w+)\s*\{\s*bindings\s*=\s*<(.*?)>\s*;'
    layers = []
    
    # Also search for layers in the entire content (not just keymap block)
    for match in re.finditer(layer_pattern, content, re.DOTALL):
        layer_name = match.group(1)
        bindings = match.group(2).strip()
        
        # Clean up the bindings - remove line breaks and extra spaces
        bindings = re.sub(r'\s+', ' ', bindings)
        bindings = bindings.strip()
        
        # Split into individual key bindings
        # Each binding starts with & and continues until the next &
        keys = re.findall(r'&[^&]+', bindings)
        keys = [k.strip() for k in keys]
        
        # Process keys to make them more readable
        processed_keys = []
        for key in keys:
            processed_key = process_key(key)
            processed_keys.append(processed_key)
        
        layers.append({
            'name': layer_name,
            'keys': processed_keys
        })
    
    return layers

def process_key(key):
    """Process a key binding to make it more readable."""
    # Remove the & prefix
    if key.startswith('&'):
        key = key[1:]
    
    # Handle different key types
    if key == 'trans':
        return {'label': '▽', 'class': 'trans', 'full': 'Transparent'}
    elif key == 'none':
        return {'label': '', 'class': 'none', 'full': 'None'}
    elif key.startswith('kp'):
        # Handle both "kp KEYNAME" and "kp" formats
        parts = key.split(None, 1)  # Split on first whitespace
        if len(parts) > 1:
            label = parts[1].strip()
            label = simplify_key_label(label)
            return {'label': label, 'class': 'key', 'full': key}
        else:
            # Malformed kp, return as-is
            return {'label': 'kp', 'class': 'key', 'full': key}
    elif key.startswith('bt '):
        parts = key.split()
        if len(parts) >= 2:
            cmd = parts[1]
            if cmd == 'BT_SEL':
                num = parts[2] if len(parts) > 2 else '?'
                return {'label': f'BT{num}', 'class': 'bluetooth', 'full': key}
            elif cmd == 'BT_CLR':
                return {'label': 'BT CLR', 'class': 'bluetooth', 'full': key}
            else:
                return {'label': 'BT', 'class': 'bluetooth', 'full': key}
    elif key.startswith('hmk_'):
        # Home row mod - extract the actual key
        parts = key.split()
        if len(parts) >= 3:
            mod = parts[1]
            actual_key = parts[2]
            mod_short = mod.replace('LGUI', 'G').replace('RGUI', 'G').replace('LALT', 'A').replace('RALT', 'A')
            mod_short = mod_short.replace('LSHFT', 'S').replace('RSHFT', 'S').replace('LCTRL', 'C').replace('RCTRL', 'C')
            mod_short = mod_short.replace('LSHIFT', 'S').replace('RSHIFT', 'S').replace('LCTRL', 'C').replace('RCTRL', 'C')
            return {'label': f'{actual_key}/{mod_short}', 'class': 'hrm', 'full': key}
        return {'label': 'HRM', 'class': 'hrm', 'full': key}
    elif key.startswith('hml ') or key.startswith('hmr '):
        # Alternative home row mod format
        parts = key.split()
        if len(parts) >= 3:
            mod = parts[1]
            actual_key = parts[2]
            return {'label': f'{actual_key}/{mod[0]}', 'class': 'hrm', 'full': key}
        return {'label': 'HRM', 'class': 'hrm', 'full': key}
    elif key.startswith('lt '):
        parts = key.split()
        if len(parts) >= 3:
            layer = parts[1]
            key_name = parts[2]
            return {'label': f'{key_name}\nL{layer}', 'class': 'layer_tap', 'full': key}
        return {'label': 'LT', 'class': 'layer_tap', 'full': key}
    elif key.startswith('mo '):
        layer = key[3:].strip()
        return {'label': f'MO\n{layer}', 'class': 'layer', 'full': key}
    elif key.startswith('macro'):
        return {'label': 'MACRO', 'class': 'macro', 'full': key}
    elif key.startswith('magic '):
        return {'label': 'MAGIC', 'class': 'magic', 'full': key}
    elif key == 'lower':
        return {'label': 'LOWER', 'class': 'layer', 'full': key}
    elif key == 'raise':
        return {'label': 'RAISE', 'class': 'layer', 'full': key}
    else:
        # Generic behavior or complex binding
        return {'label': key[:8], 'class': 'behavior', 'full': key}

def simplify_key_label(label):
    """Simplify common key labels for display."""
    replacements = {
        'SPACE': 'Space',
        'ENTER': 'Enter',
        'RETURN': 'Enter',
        'RET': 'Enter',
        'BACKSPACE': 'BkSp',
        'BSPC': 'BkSp',
        'DELETE': 'Del',
        'DEL': 'Del',
        'ESCAPE': 'Esc',
        'ESC': 'Esc',
        'TAB': 'Tab',
        'LEFT': '←',
        'RIGHT': '→',
        'UP': '↑',
        'DOWN': '↓',
        'HOME': 'Home',
        'END': 'End',
        'PAGE_UP': 'PgUp',
        'PG_UP': 'PgUp',
        'PAGE_DOWN': 'PgDn',
        'PG_DN': 'PgDn',
        'LSHIFT': 'LShift',
        'RSHIFT': 'RShift',
        'LCTRL': 'LCtrl',
        'RCTRL': 'RCtrl',
        'LALT': 'LAlt',
        'RALT': 'RAlt',
        'LGUI': 'LGui',
        'RGUI': 'RGui',
        'LSHFT': 'LShift',
        'RSHFT': 'RShift',
        'COMMA': ',',
        'DOT': '.',
        'SLASH': '/',
        'FSLH': '/',
        'SEMI': ';',
        'SQT': "'",
        'DQT': '"',
        'COLON': ':',
        'MINUS': '-',
        'EQUAL': '=',
        'PLUS': '+',
        'STAR': '*',
        'PERCENT': '%',
        'DOLLAR': '$',
        'DLLR': '$',
        'HASH': '#',
        'AT': '@',
        'EXCL': '!',
        'QMARK': '?',
        'AMPS': '&',
        'PIPE': '|',
        'CARET': '^',
        'TILDE': '~',
        'GRAVE': '`',
        'UNDER': '_',
        'LPAR': '(',
        'RPAR': ')',
        'LBKT': '[',
        'RBKT': ']',
        'LBRC': '{',
        'RBRC': '}',
        'LT': '<',
        'GT': '>',
        'BSLH': '\\',
    }
    
    # Handle function keys
    if label.startswith('F') and len(label) <= 3 and (label[1:].isdigit() or label == 'F10'):
        return label  # Keep as is
    
    # Handle number keys
    if label.startswith('N') and len(label) == 2 and label[1].isdigit():
        return label[1]  # Just the number
    
    # Apply replacements
    return replacements.get(label, label)

def generate_html(layers, output_path):
    """Generate the HTML visualization file."""
    html_template = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Glove80 Keyboard Layout</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #1e1e1e;
            color: #e0e0e0;
            padding: 20px;
            overflow-x: auto;
        }
        
        .container {
            min-width: 1400px;
            margin: 0 auto;
        }
        
        h1 {
            text-align: center;
            margin-bottom: 20px;
            color: #61dafb;
        }
        
        .layer-selector {
            display: flex;
            justify-content: center;
            gap: 10px;
            margin-bottom: 30px;
        }
        
        .layer-btn {
            padding: 10px 20px;
            background: #333;
            color: #e0e0e0;
            border: 2px solid #555;
            border-radius: 5px;
            cursor: pointer;
            transition: all 0.3s;
            font-size: 14px;
            font-weight: 500;
        }
        
        .layer-btn:hover {
            background: #444;
            border-color: #61dafb;
        }
        
        .layer-btn.active {
            background: #61dafb;
            color: #1e1e1e;
            border-color: #61dafb;
        }
        
        .keyboard-container {
            display: flex;
            justify-content: center;
            gap: 40px;
            padding: 20px;
            background: #2a2a2a;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }
        
        .keyboard-split {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .keyboard-main {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        
        .keyboard-thumb {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-top: 16px;
            align-items: center;
        }
        
        .thumb-row {
            display: flex;
            gap: 4px;
        }
        
        .row {
            display: flex;
            gap: 4px;
            justify-content: center;
        }
        
        .row.left {
            justify-content: flex-end;
        }
        
        .row.right {
            justify-content: flex-start;
        }
        
        .key {
            width: 54px;
            height: 54px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #3a3a3a;
            border: 2px solid #555;
            border-radius: 8px;
            font-size: 11px;
            font-weight: 600;
            transition: all 0.2s;
            cursor: default;
            position: relative;
            text-align: center;
            padding: 2px;
            white-space: pre-line;
            line-height: 1.2;
        }
        
        .key:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            z-index: 10;
        }
        
        .key:hover::after {
            content: attr(data-full);
            position: absolute;
            bottom: -30px;
            left: 50%;
            transform: translateX(-50%);
            background: #000;
            color: #fff;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 10px;
            white-space: nowrap;
            z-index: 100;
        }
        
        .key.empty {
            visibility: hidden;
        }
        
        /* Key type colors */
        .key.trans {
            background: #2a2a2a;
            color: #666;
            border-style: dashed;
        }
        
        .key.none {
            background: #222;
            border-color: #333;
        }
        
        .key.hrm {
            background: #4a3a5a;
            color: #b19cd9;
            border-color: #7a6a8a;
        }
        
        .key.layer, .key.layer_tap {
            background: #3a5a4a;
            color: #90ee90;
        }
        
        .key.macro {
            background: #5a4a3a;
            color: #ffa500;
        }
        
        .key.bluetooth {
            background: #3a4a5a;
            color: #87ceeb;
        }
        
        .key.magic {
            background: #5a3a5a;
            color: #ff69b4;
        }
        
        /* Special key sizes */
        .key.thumb {
            width: 60px;
            height: 50px;
            border-radius: 10px;
        }
        
        .key.center-mod {
            width: 50px;
            height: 45px;
            background: #444;
            margin: 0 2px;
        }
        
        /* Row-specific styling */
        .row0 .key {
            width: 48px;
            height: 42px;
            font-size: 10px;
        }
        
        .legend {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-top: 30px;
            flex-wrap: wrap;
        }
        
        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .legend-key {
            width: 30px;
            height: 30px;
            border-radius: 5px;
            border: 2px solid #555;
        }
        
        .info {
            text-align: center;
            margin-top: 20px;
            color: #888;
            font-size: 14px;
        }
        
        .info p {
            margin: 5px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Glove80 Keyboard Layout Visualization</h1>
        
        <div class="layer-selector" id="layerSelector">
            <!-- Layer buttons will be inserted here -->
        </div>
        
        <div class="keyboard-container">
            <div class="keyboard-split" id="leftSplit">
                <div class="keyboard-main" id="leftMain">
                    <!-- Left main keys will be inserted here -->
                </div>
                <div class="keyboard-thumb" id="leftThumb">
                    <!-- Left thumb cluster will be inserted here -->
                </div>
            </div>
            
            <div class="keyboard-split" id="rightSplit">
                <div class="keyboard-main" id="rightMain">
                    <!-- Right main keys will be inserted here -->
                </div>
                <div class="keyboard-thumb" id="rightThumb">
                    <!-- Right thumb cluster will be inserted here -->
                </div>
            </div>
        </div>
        
        <div class="legend">
            <div class="legend-item">
                <div class="legend-key key"></div>
                <span>Regular Key</span>
            </div>
            <div class="legend-item">
                <div class="legend-key key hrm"></div>
                <span>Home Row Mod</span>
            </div>
            <div class="legend-item">
                <div class="legend-key key layer"></div>
                <span>Layer</span>
            </div>
            <div class="legend-item">
                <div class="legend-key key macro"></div>
                <span>Macro</span>
            </div>
            <div class="legend-item">
                <div class="legend-key key bluetooth"></div>
                <span>Bluetooth</span>
            </div>
            <div class="legend-item">
                <div class="legend-key key magic"></div>
                <span>Magic</span>
            </div>
            <div class="legend-item">
                <div class="legend-key key trans"></div>
                <span>Transparent</span>
            </div>
        </div>
        
        <div class="info">
            <p>Generated from config/glove80.keymap</p>
            <p>Hover over keys to see full binding</p>
            <p>HRM format: Key/Modifier (e.g., A/G means A key with GUI modifier on hold)</p>
        </div>
    </div>
    
    <script>
        const layers = ''' + json.dumps(layers, indent=8) + ''';
        const leftLayout = ''' + json.dumps(GLOVE80_LAYOUT['left'], indent=8) + ''';
        const rightLayout = ''' + json.dumps(GLOVE80_LAYOUT['right'], indent=8) + ''';
        const centerLayout = ''' + json.dumps(GLOVE80_LAYOUT.get('center', []), indent=8) + ''';
        
        let currentLayer = 0;
        
        function renderKeyboard(layerIndex) {
            const layer = layers[layerIndex];
            if (!layer) return;
            
            // Clear containers
            document.getElementById('leftMain').innerHTML = '';
            document.getElementById('rightMain').innerHTML = '';
            document.getElementById('leftThumb').innerHTML = '';
            document.getElementById('rightThumb').innerHTML = '';
            
            // Render left side with integrated thumb cluster
            renderIntegratedSection('leftMain', leftLayout, layer.keys, 'left');
            
            // Render right side with integrated thumb cluster
            renderIntegratedSection('rightMain', rightLayout, layer.keys, 'right');
            
            // Render center modifiers between the thumb clusters
            renderCenterMods('leftThumb', centerLayout, layer.keys);
        }
        
        function renderIntegratedSection(elementId, layout, keys, side) {
            const container = document.getElementById(elementId);
            
            layout.forEach((row, rowIndex) => {
                const rowDiv = document.createElement('div');
                rowDiv.className = `row row${rowIndex} ${side}`;
                
                // Check if this is the thumb row (last row)
                const isThumbRow = rowIndex === layout.length - 1;
                
                row.forEach((keyPos) => {
                    if (keyPos === null || keyPos === undefined) {
                        // Empty placeholder
                        const keyDiv = document.createElement('div');
                        keyDiv.className = 'key empty';
                        rowDiv.appendChild(keyDiv);
                    } else {
                        const keyData = keys[keyPos] || {label: '?', class: 'key', full: '?'};
                        const keyDiv = document.createElement('div');
                        keyDiv.className = `key ${keyData.class}`;
                        if (isThumbRow) {
                            keyDiv.classList.add('thumb');
                        }
                        keyDiv.textContent = keyData.label;
                        keyDiv.setAttribute('data-full', keyData.full || keyData.label);
                        rowDiv.appendChild(keyDiv);
                    }
                });
                
                container.appendChild(rowDiv);
            });
        }
        
        function renderCenterMods(elementId, centerLayout, keys) {
            const container = document.getElementById(elementId);
            
            centerLayout.forEach((modRow) => {
                const rowDiv = document.createElement('div');
                rowDiv.className = 'row center-mods';
                
                modRow.forEach((keyPos) => {
                    const keyData = keys[keyPos] || {label: '?', class: 'key', full: '?'};
                    const keyDiv = document.createElement('div');
                    keyDiv.className = `key center-mod ${keyData.class}`;
                    keyDiv.textContent = keyData.label;
                    keyDiv.setAttribute('data-full', keyData.full || keyData.label);
                    rowDiv.appendChild(keyDiv);
                });
                
                container.appendChild(rowDiv);
            });
        }
        
        function initLayerSelector() {
            const selector = document.getElementById('layerSelector');
            
            layers.forEach((layer, index) => {
                const btn = document.createElement('button');
                btn.className = 'layer-btn';
                btn.textContent = layer.name;
                btn.onclick = () => {
                    currentLayer = index;
                    renderKeyboard(index);
                    
                    // Update active button
                    document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                };
                
                if (index === 0) {
                    btn.classList.add('active');
                }
                
                selector.appendChild(btn);
            });
        }
        
        // Initialize
        initLayerSelector();
        renderKeyboard(0);
    </script>
</body>
</html>'''
    
    with open(output_path, 'w') as f:
        f.write(html_template)

def main():
    # Paths
    project_root = Path(__file__).parent.parent
    keymap_path = project_root / 'config' / 'glove80.keymap'
    output_path = project_root / 'layout.html'
    
    print(f"Parsing keymap from {keymap_path}...")
    layers = parse_keymap(keymap_path)
    
    print(f"Found {len(layers)} layers:")
    for layer in layers:
        print(f"  - {layer['name']} ({len(layer['keys'])} keys)")
    
    print(f"Generating HTML to {output_path}...")
    generate_html(layers, output_path)
    
    print("Done! Open layout.html in your browser to view the visualization.")

if __name__ == '__main__':
    main()