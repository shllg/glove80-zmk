#!/usr/bin/env python3
"""
Export ZMK keymap to structured JSON format for visualization.
Creates a clean structure with left, right, and thumb clusters.
"""

import re
import json
from pathlib import Path
from typing import Dict, List, Optional, Any

# Glove80 physical layout structure
# Total 80 keys: 26 left main, 26 right main, 14 left thumb area, 14 right thumb area
LAYOUT_STRUCTURE = {
    'left': {
        'rows': [
            {'start': 0, 'count': 5},   # F1-F5
            {'start': 10, 'count': 6},  # = 1-5
            {'start': 22, 'count': 6},  # Tab Q-T
            {'start': 34, 'count': 6},  # Esc A-G
            {'start': 46, 'count': 6},  # ` Z-B
        ]
    },
    'right': {
        'rows': [
            {'start': 5, 'count': 5},   # F6-F10
            {'start': 16, 'count': 6},  # 6-0 -
            {'start': 28, 'count': 6},  # Y-P \
            {'start': 40, 'count': 6},  # H-; '
            {'start': 58, 'count': 6},  # N-/ PgUp
        ]
    },
    'left_thumb': {
        'rows': [
            {'positions': [52]},         # Lower key
            {'positions': [64, 65, 66, 67, 68]},  # Magic, nav keys
            {'positions': [69, 70, 71]}, # Space cluster
        ]
    },
    'right_thumb': {
        'rows': [
            {'positions': [53, 54, 55, 56, 57]},  # Center mods
            {'positions': [75, 76, 77, 78, 79]},  # Nav keys, PgDn
            {'positions': [72, 73, 74]}, # Backspace, Del, Enter
        ]
    }
}

def parse_keymap(keymap_path: Path) -> Dict[str, Any]:
    """Parse the ZMK keymap file and extract all layers."""
    with open(keymap_path, 'r') as f:
        content = f.read()
    
    # Find the keymap block
    keymap_match = re.search(r'keymap\s*\{.*?compatible\s*=\s*"zmk,keymap";\s*(.*)\s*\};', 
                            content, re.DOTALL)
    if not keymap_match:
        raise ValueError("Could not find keymap in file")
    
    # Find all layers
    layer_pattern = r'layer_(\w+)\s*\{\s*bindings\s*=\s*<(.*?)>\s*;\s*\}'
    layers = []
    
    for match in re.finditer(layer_pattern, content, re.DOTALL):
        layer_name = match.group(1)
        bindings = match.group(2).strip()
        
        # Clean up the bindings
        bindings = re.sub(r'\s+', ' ', bindings)
        bindings = bindings.strip()
        
        # Split into individual key bindings
        keys = re.findall(r'&[^&]+', bindings)
        keys = [k.strip() for k in keys]
        
        # Process keys
        processed_keys = []
        for key in keys:
            processed_keys.append(process_key_binding(key))
        
        # Structure the layer
        structured_layer = structure_layer(layer_name, processed_keys)
        layers.append(structured_layer)
    
    return {
        'keyboard': 'glove80',
        'total_keys': 80,
        'layers': layers,
        'layout_type': 'split',
        'metadata': {
            'left_keys': 26,
            'right_keys': 26,
            'left_thumb_keys': 14,
            'right_thumb_keys': 14
        }
    }

def process_key_binding(binding: str) -> Dict[str, Any]:
    """Process a single key binding into structured format."""
    # Remove the & prefix
    if binding.startswith('&'):
        binding = binding[1:]
    
    # Determine the type and extract info
    key_info = {
        'raw': binding,
        'type': 'key',
        'label': '',
        'hold': None,
        'tap': None,
        'class': 'regular'
    }
    
    # Handle different binding types
    if binding == 'trans':
        key_info['type'] = 'transparent'
        key_info['label'] = '▽'
        key_info['class'] = 'trans'
    elif binding == 'none':
        key_info['type'] = 'none'
        key_info['label'] = ''
        key_info['class'] = 'none'
    elif binding.startswith('kp '):
        key_name = binding[3:].strip()
        key_info['type'] = 'key'
        key_info['label'] = format_key_label(key_name)
        key_info['tap'] = key_name
    elif binding.startswith('bt '):
        parts = binding.split()
        key_info['type'] = 'bluetooth'
        key_info['class'] = 'bluetooth'
        if len(parts) >= 2:
            if parts[1] == 'BT_CLR':
                key_info['label'] = 'BT CLR'
            elif parts[1] == 'BT_CLR_ALL':
                key_info['label'] = 'BT CLR ALL'
            elif parts[1] == 'BT_SEL' and len(parts) > 2:
                key_info['label'] = f'BT{parts[2]}'
            else:
                key_info['label'] = 'BT'
    elif binding.startswith('hmk_') or binding.startswith('hml ') or binding.startswith('hmr '):
        # Home row mod
        parts = binding.split()
        key_info['type'] = 'hold_tap'
        key_info['class'] = 'hrm'
        if len(parts) >= 3:
            modifier = parts[1]
            tap_key = parts[2]
            key_info['hold'] = modifier
            key_info['tap'] = tap_key
            key_info['label'] = f'{format_key_label(tap_key)}/{format_modifier_short(modifier)}'
        else:
            key_info['label'] = 'HRM'
    elif binding == 'lower':
        key_info['type'] = 'layer'
        key_info['class'] = 'layer'
        key_info['label'] = 'LOWER'
    elif binding.startswith('mo '):
        layer_num = binding[3:].strip()
        key_info['type'] = 'layer'
        key_info['class'] = 'layer'
        key_info['label'] = f'L{layer_num}'
    elif binding.startswith('magic'):
        key_info['type'] = 'magic'
        key_info['class'] = 'magic'
        key_info['label'] = 'MAGIC'
    elif binding.startswith('macro'):
        key_info['type'] = 'macro'
        key_info['class'] = 'macro'
        key_info['label'] = 'MACRO'
    elif binding.startswith('rgb_ug'):
        key_info['type'] = 'rgb'
        key_info['class'] = 'rgb'
        parts = binding.split()
        if len(parts) > 1:
            key_info['label'] = parts[1].replace('RGB_', '')
        else:
            key_info['label'] = 'RGB'
    elif binding == 'bootloader':
        key_info['type'] = 'system'
        key_info['class'] = 'system'
        key_info['label'] = 'BOOT'
    elif binding == 'sys_reset':
        key_info['type'] = 'system'
        key_info['class'] = 'system'
        key_info['label'] = 'RESET'
    elif binding.startswith('to '):
        layer_num = binding[3:].strip()
        key_info['type'] = 'layer'
        key_info['class'] = 'layer'
        key_info['label'] = f'TO {layer_num}'
    elif binding.startswith('out '):
        output = binding[4:].strip()
        key_info['type'] = 'output'
        key_info['class'] = 'output'
        key_info['label'] = output.replace('OUT_', '')
    else:
        # Generic behavior
        key_info['label'] = binding.split()[0] if ' ' in binding else binding
    
    return key_info

def format_key_label(label: str) -> str:
    """Format key labels for display."""
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
        'LALT': 'LAlt',
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
        'MINUS': '-',
        'EQUAL': '=',
        'GRAVE': '`',
        'LBKT': '[',
        'RBKT': ']',
        'BSLH': '\\',
        'LBRC': '{',
        'RBRC': '}',
        'LPAR': '(',
        'RPAR': ')',
    }
    
    # Handle function keys
    if label.startswith('F') and (label[1:].isdigit() or label == 'F10'):
        return label
    
    # Handle number keys
    if label.startswith('N') and len(label) == 2 and label[1].isdigit():
        return label[1]
    
    # Single letters
    if len(label) == 1 and label.isalpha():
        return label
    
    return replacements.get(label, label)

def format_modifier_short(modifier: str) -> str:
    """Format modifier names to short form."""
    replacements = {
        'LGUI': 'G',
        'RGUI': 'G',
        'LALT': 'A',
        'RALT': 'A',
        'LSHFT': 'S',
        'RSHFT': 'S',
        'LSHIFT': 'S',
        'RSHIFT': 'S',
        'LCTRL': 'C',
        'RCTRL': 'C',
    }
    return replacements.get(modifier, modifier[0] if modifier else '?')

def structure_layer(name: str, keys: List[Dict]) -> Dict[str, Any]:
    """Structure a layer into left, right, and thumb clusters."""
    layer = {
        'name': name,
        'left': [],
        'right': [],
        'left_thumb': [],
        'right_thumb': []
    }
    
    # Process left main keys
    for row_info in LAYOUT_STRUCTURE['left']['rows']:
        row = []
        for i in range(row_info['count']):
            idx = row_info['start'] + i
            if idx < len(keys):
                row.append(keys[idx])
            else:
                row.append({'type': 'none', 'label': '', 'class': 'none'})
        layer['left'].append(row)
    
    # Process right main keys
    for row_info in LAYOUT_STRUCTURE['right']['rows']:
        row = []
        for i in range(row_info['count']):
            idx = row_info['start'] + i
            if idx < len(keys):
                row.append(keys[idx])
            else:
                row.append({'type': 'none', 'label': '', 'class': 'none'})
        layer['right'].append(row)
    
    # Process left thumb cluster
    for row_info in LAYOUT_STRUCTURE['left_thumb']['rows']:
        row = []
        for pos in row_info['positions']:
            if pos < len(keys):
                row.append(keys[pos])
            else:
                row.append({'type': 'none', 'label': '', 'class': 'none'})
        layer['left_thumb'].append(row)
    
    # Process right thumb cluster
    for row_info in LAYOUT_STRUCTURE['right_thumb']['rows']:
        row = []
        for pos in row_info['positions']:
            if pos < len(keys):
                row.append(keys[pos])
            else:
                row.append({'type': 'none', 'label': '', 'class': 'none'})
        layer['right_thumb'].append(row)
    
    return layer

def main():
    # Paths
    project_root = Path(__file__).parent.parent
    keymap_path = project_root / 'config' / 'glove80.keymap'
    output_path = project_root / 'keymap.json'
    
    print(f"Parsing keymap from {keymap_path}...")
    keymap_data = parse_keymap(keymap_path)
    
    print(f"Found {len(keymap_data['layers'])} layers:")
    for layer in keymap_data['layers']:
        print(f"  - {layer['name']}")
    
    # Write JSON
    with open(output_path, 'w') as f:
        json.dump(keymap_data, f, indent=2)
    
    print(f"Exported keymap to {output_path}")
    
    # Also write a minified version
    output_min_path = project_root / 'keymap.min.json'
    with open(output_min_path, 'w') as f:
        json.dump(keymap_data, f, separators=(',', ':'))
    
    print(f"Exported minified version to {output_min_path}")

if __name__ == '__main__':
    main()