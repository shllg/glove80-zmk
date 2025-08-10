#!/usr/bin/env python3
"""
Visual Keymap Display for Glove80
Shows the current keymap configuration in a visual layout
"""

import re
import sys
import os
from pathlib import Path

# ANSI color codes
class Colors:
    RESET = '\033[0m'
    BOLD = '\033[1m'
    DIM = '\033[2m'
    
    # Key types
    ALPHA = '\033[38;5;15m'      # White for letters
    NUMBER = '\033[38;5;226m'     # Yellow for numbers
    FUNC = '\033[38;5;208m'       # Orange for function keys
    MOD = '\033[38;5;196m'        # Red for modifiers
    NAV = '\033[38;5;45m'         # Cyan for navigation
    SYMBOL = '\033[38;5;141m'     # Purple for symbols
    LAYER = '\033[38;5;40m'       # Green for layer keys
    MACRO = '\033[38;5;213m'      # Pink for macros
    SPECIAL = '\033[38;5;99m'     # Blue for special keys
    COMBO = '\033[38;5;220m'      # Gold for combo keys
    TRANS = '\033[38;5;240m'      # Dark gray for transparent
    NONE = '\033[38;5;235m'       # Very dark gray for none
    
    # Backgrounds
    BG_MOD = '\033[48;5;52m'      # Dark red background for mods
    BG_LAYER = '\033[48;5;22m'    # Dark green for layers
    BG_THUMB = '\033[48;5;17m'    # Dark blue for thumb keys

# Key name mappings
KEY_LABELS = {
    # Letters
    'A': 'A', 'B': 'B', 'C': 'C', 'D': 'D', 'E': 'E', 'F': 'F', 'G': 'G',
    'H': 'H', 'I': 'I', 'J': 'J', 'K': 'K', 'L': 'L', 'M': 'M', 'N': 'N',
    'O': 'O', 'P': 'P', 'Q': 'Q', 'R': 'R', 'S': 'S', 'T': 'T', 'U': 'U',
    'V': 'V', 'W': 'W', 'X': 'X', 'Y': 'Y', 'Z': 'Z',
    
    # Numbers
    'N0': '0', 'N1': '1', 'N2': '2', 'N3': '3', 'N4': '4',
    'N5': '5', 'N6': '6', 'N7': '7', 'N8': '8', 'N9': '9',
    
    # Function keys
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5',
    'F6': 'F6', 'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10',
    'F11': 'F11', 'F12': 'F12',
    
    # Modifiers
    'LSHFT': 'LShift', 'RSHFT': 'RShift', 'LSHIFT': 'LShift', 'RSHIFT': 'RShift',
    'LCTRL': 'LCtrl', 'RCTRL': 'RCtrl', 'LCTL': 'LCtrl', 'RCTL': 'RCtrl',
    'LALT': 'LAlt', 'RALT': 'RAlt', 'LGUI': 'LGui', 'RGUI': 'RGui',
    'LCMD': 'LCmd', 'RCMD': 'RCmd', 'LWIN': 'LWin', 'RWIN': 'RWin',
    
    # Navigation
    'UP': '↑', 'DOWN': '↓', 'LEFT': '←', 'RIGHT': '→',
    'HOME': 'Home', 'END': 'End', 'PG_UP': 'PgUp', 'PG_DN': 'PgDn',
    'PAGE_UP': 'PgUp', 'PAGE_DOWN': 'PgDn',
    
    # Editing
    'ESC': 'Esc', 'ESCAPE': 'Esc', 'TAB': 'Tab',
    'ENTER': 'Enter', 'RET': 'Enter', 'RETURN': 'Enter',
    'SPACE': 'Space', 'SPC': 'Space',
    'BSPC': 'BkSp', 'BACKSPACE': 'BkSp', 'BKSP': 'BkSp',
    'DEL': 'Del', 'DELETE': 'Del',
    'INS': 'Ins', 'INSERT': 'Ins',
    
    # Symbols
    'MINUS': '-', 'EQUAL': '=', 'PLUS': '+',
    'LBKT': '[', 'RBKT': ']', 'LBRC': '{', 'RBRC': '}',
    'LPAR': '(', 'RPAR': ')', 'LPAREN': '(', 'RPAREN': ')',
    'LT': '<', 'GT': '>',
    'COMMA': ',', 'DOT': '.', 'PERIOD': '.',
    'SEMI': ';', 'SEMICOLON': ';', 'COLON': ':',
    'SQT': "'", 'APOS': "'", 'APOSTROPHE': "'",
    'DQT': '"', 'DOUBLE_QUOTES': '"',
    'GRAVE': '`', 'TILDE': '~',
    'BSLH': '\\', 'BACKSLASH': '\\', 'BSLASH': '\\',
    'FSLH': '/', 'SLASH': '/', 'FSLASH': '/',
    'PIPE': '|', 'QMARK': '?', 'QUESTION': '?',
    'EXCL': '!', 'EXCLAMATION': '!',
    'AT': '@', 'HASH': '#', 'POUND': '#',
    'DOLLAR': '$', 'DLLR': '$',
    'PERCENT': '%', 'PRCNT': '%',
    'CARET': '^', 'AMPERSAND': '&', 'AMPS': '&',
    'STAR': '*', 'ASTERISK': '*', 'ASTRK': '*',
    'UNDERSCORE': '_', 'UNDER': '_',
    
    # Special
    'CAPS': 'Caps', 'CAPSLOCK': 'Caps', 'CAPS_LOCK': 'Caps',
    'SLCK': 'ScrLk', 'SCROLLLOCK': 'ScrLk',
    'NLCK': 'NumLk', 'NUMLOCK': 'NumLk',
    'PSCRN': 'PrtSc', 'PRINTSCREEN': 'PrtSc',
    'PAUSE_BREAK': 'Pause',
    
    # Bluetooth
    'BT_SEL_0': 'BT0', 'BT_SEL_1': 'BT1', 'BT_SEL_2': 'BT2',
    'BT_SEL_3': 'BT3', 'BT_SEL_4': 'BT4',
    'BT_CLR': 'BTClr', 'BT_CLR_ALL': 'BTClrAll',
    'BT_NXT': 'BTNext', 'BT_PRV': 'BTPrev',
    
    # RGB
    'RGB_TOG': 'RGBTog', 'RGB_HUI': 'Hue+', 'RGB_HUD': 'Hue-',
    'RGB_SAI': 'Sat+', 'RGB_SAD': 'Sat-',
    'RGB_BRI': 'Brt+', 'RGB_BRD': 'Brt-',
    'RGB_EFF': 'Effect', 'RGB_EFR': 'Eff-',
}

def parse_keymap(keymap_path, layer_num=0):
    """Parse the keymap file and extract key bindings for a specific layer"""
    
    with open(keymap_path, 'r') as f:
        content = f.read()
    
    # Find all layer definitions - more flexible pattern
    layer_pattern = r'layer_\w+\s*\{[^}]*?bindings\s*=\s*<([^>]+)>'
    layers = re.findall(layer_pattern, content, re.DOTALL | re.MULTILINE)
    
    if not layers:
        # Try alternate patterns
        layer_pattern = r'(?:base_layer|lower_layer|magic_layer)\s*\{[^}]*?bindings\s*=\s*<([^>]+)>'
        layers = re.findall(layer_pattern, content, re.DOTALL | re.MULTILINE)
    
    if not layers:
        # Try simple bindings pattern
        layer_pattern = r'bindings\s*=\s*<([^>]+)>'
        layers = re.findall(layer_pattern, content, re.DOTALL | re.MULTILINE)
    
    if layer_num >= len(layers):
        print(f"Layer {layer_num} not found. Available layers: 0-{len(layers)-1}")
        return None
    
    # Parse the selected layer
    layer_content = layers[layer_num]
    
    # Clean up whitespace
    layer_content = re.sub(r'\s+', ' ', layer_content)
    
    # Extract key bindings - match various formats
    key_pattern = r'&(\w+)(?:\s+([A-Z0-9_]+)(?:\s+([A-Z0-9_]+))?)?'
    keys = re.findall(key_pattern, layer_content)
    
    # Process keys
    processed_keys = []
    for key in keys:
        if key[0] == 'kp':
            # Regular keypress
            processed_keys.append(('kp', key[1]))
        elif key[0] in ['mo', 'tog', 'to']:
            # Layer keys
            processed_keys.append((key[0], key[1] if key[1] else ''))
        elif key[0] in ['hm', 'hml', 'hmr', 'hmk_left_pinky', 'hmk_left_ring', 'hmk_left_middle', 'hmk_left_index',
                        'hmk_right_pinky', 'hmk_right_ring', 'hmk_right_middle', 'hmk_right_index', 
                        'hmk_left_thumb_middle_inner']:
            # Home row mods and custom home row behaviors
            if len(key) > 2 and key[2]:
                processed_keys.append(('hrm', f"{key[1]}+{key[2]}"))
            elif key[1]:
                processed_keys.append(('hrm', key[1]))
            else:
                processed_keys.append(('hrm', 'HRM'))
        elif key[0] == 'lt_thumb' or key[0] == 'lower':
            # Layer tap
            if key[0] == 'lower':
                processed_keys.append(('lt', 'Lower'))
            else:
                processed_keys.append(('lt', f"L{key[1]}:{key[2]}" if key[2] else key[1]))
        elif key[0] == 'trans':
            processed_keys.append(('trans', '▽'))
        elif key[0] == 'none':
            processed_keys.append(('none', '✕'))
        elif key[0] == 'bootloader':
            processed_keys.append(('boot', 'BOOT'))
        elif key[0] == 'sys_reset':
            processed_keys.append(('boot', 'RESET'))
        elif key[0] == 'magic':
            processed_keys.append(('layer', 'MAGIC'))
        elif key[0].startswith('bt'):
            # Bluetooth commands
            bt_cmd = key[0].upper()
            if key[1]:
                bt_cmd += f"_{key[1]}"
            processed_keys.append(('bt', bt_cmd))
        elif key[0].startswith('rgb'):
            # RGB commands
            rgb_cmd = key[0].upper()
            processed_keys.append(('rgb', rgb_cmd))
        elif key[0].startswith('macro'):
            # Macro behaviors
            processed_keys.append(('macro', key[0]))
        elif key[0] == 'out':
            # Output switching
            processed_keys.append(('special', key[1] if key[1] else 'OUT'))
        else:
            # Other behaviors/macros
            processed_keys.append(('macro', key[0]))
    
    return processed_keys

def format_key(key_type, key_value, width=8, layer_num=0):
    """Format a key with color and proper width"""
    
    # Get the display label
    label = KEY_LABELS.get(key_value, key_value)
    
    # Truncate if too long
    if len(label) > width:
        label = label[:width-1] + '…'
    
    # Apply color based on type
    color = Colors.RESET
    if key_type == 'trans':
        color = Colors.TRANS
        label = '▽'
    elif key_type == 'none':
        color = Colors.NONE
        label = '✕'
    elif key_type == 'boot':
        color = Colors.SPECIAL + Colors.BOLD
    elif key_type == 'bt':
        color = Colors.SPECIAL
    elif key_type == 'rgb':
        color = Colors.MACRO
    elif key_type == 'hrm':
        color = Colors.MOD + Colors.BG_MOD
        parts = label.split('+')
        if len(parts) == 2:
            label = f"{KEY_LABELS.get(parts[0], parts[0][:3])}+{KEY_LABELS.get(parts[1], parts[1])}"
    elif key_type in ['mo', 'tog', 'to', 'lt']:
        color = Colors.LAYER + Colors.BG_LAYER
    elif key_type == 'macro':
        # Special colors for specific macros in symbol layer
        if layer_num == 1:
            if 'parenthesis' in key_value or 'PAREN' in key_value:
                color = '\033[38;5;219m'  # Light pink
            elif 'bracket' in key_value or 'BRKT' in key_value:
                color = '\033[38;5;117m'  # Light blue
            elif 'brace' in key_value or 'BRACE' in key_value:
                color = '\033[38;5;117m'  # Light blue
            elif 'quote' in key_value or 'QUOTE' in key_value:
                color = '\033[38;5;195m'  # Very light cyan
            elif 'arrow' in key_value or 'equal_gt' in key_value:
                color = '\033[38;5;228m'  # Yellow
            elif 'lt_gt' in key_value:
                color = '\033[38;5;117m'  # Light blue
            else:
                color = Colors.MACRO
        else:
            color = Colors.MACRO
    elif key_type == 'kp':
        # Enhanced symbol layer coloring
        if layer_num == 1:
            # Symbol layer specific colors
            if key_value in ['LPAR', 'RPAR', 'LPAREN', 'RPAREN']:
                color = '\033[38;5;219m'  # Light pink
            elif key_value in ['LBKT', 'RBKT', 'LBRC', 'RBRC']:
                color = '\033[38;5;117m'  # Light blue
            elif key_value in ['SQT', 'DQT', 'GRAVE']:
                color = '\033[38;5;195m'  # Very light cyan
            elif key_value in ['EXCL', 'HASH', 'TILDE']:
                color = '\033[38;5;213m'  # Pink
            elif key_value in ['CARET', 'AMPS', 'PIPE']:
                color = '\033[38;5;141m'  # Purple
            elif key_value in ['EQUAL', 'PLUS', 'MINUS', 'UNDER', 'STAR', 'FSLH', 'PRCNT']:
                color = '\033[38;5;228m'  # Yellow
            elif key_value in ['DLLR', 'AT']:
                color = '\033[38;5;120m'  # Light green
            elif key_value in ['LT', 'GT']:
                color = '\033[38;5;117m'  # Light blue
            elif key_value in ['COLON', 'SEMI', 'COMMA', 'DOT', 'QMARK']:
                color = '\033[38;5;186m'  # Light yellow
            else:
                color = Colors.SYMBOL
        else:
            # Regular coloring for other layers
            if key_value in ['LSHFT', 'RSHFT', 'LCTRL', 'RCTRL', 'LALT', 'RALT', 'LGUI', 'RGUI']:
                color = Colors.MOD
            elif key_value.startswith('F'):
                color = Colors.FUNC
            elif key_value.startswith('N'):
                color = Colors.NUMBER
            elif key_value in ['UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PG_UP', 'PG_DN']:
                color = Colors.NAV
            elif len(key_value) == 1 and key_value.isalpha():
                color = Colors.ALPHA
            else:
                color = Colors.SYMBOL
    
    # Center the label
    padded = label.center(width)
    
    return f"{color}{padded}{Colors.RESET}"

def display_keymap(keys, layer_num=0):
    """Display the keymap in Glove80 layout"""
    
    if not keys or len(keys) < 76:
        print(f"Error: Invalid keymap data (found {len(keys)} keys, expected at least 76)")
        return
    
    # Glove80 layout structure
    print("\n" + "="*100)
    layer_name = ["Base", "Symbol/Lower", "Combos", "Magic"][layer_num] if layer_num < 4 else f"Layer {layer_num}"
    print(" " * 35 + Colors.BOLD + f"GLOVE80 KEYMAP - {layer_name}" + Colors.RESET)
    print("="*100 + "\n")
    
    # Function row
    print("  ", end="")
    for i in [0, 1, 2, 3, 4]:
        print(format_key(*keys[i], layer_num=layer_num), end=" ")
    print(" " * 20, end="")
    for i in [5, 6, 7, 8, 9]:
        print(format_key(*keys[i], layer_num=layer_num), end=" ")
    print()
    
    # Number row
    print("  ", end="")
    for i in [10, 11, 12, 13, 14, 15]:
        print(format_key(*keys[i], 7, layer_num), end=" ")
    print(" " * 8, end="")
    for i in [16, 17, 18, 19, 20, 21]:
        print(format_key(*keys[i], 7, layer_num), end=" ")
    print()
    
    # Top alpha row
    print("  ", end="")
    for i in [22, 23, 24, 25, 26, 27]:
        print(format_key(*keys[i], 7, layer_num), end=" ")
    print(" " * 8, end="")
    for i in [28, 29, 30, 31, 32, 33]:
        print(format_key(*keys[i], 7, layer_num), end=" ")
    print()
    
    # Home row
    print("  ", end="")
    for i in [34, 35, 36, 37, 38, 39]:
        print(format_key(*keys[i], 7, layer_num), end=" ")
    print(" " * 8, end="")
    for i in [40, 41, 42, 43, 44, 45]:
        print(format_key(*keys[i], 7, layer_num), end=" ")
    print()
    
    # Bottom row
    print("  ", end="")
    for i in [46, 47, 48, 49, 50, 51]:
        print(format_key(*keys[i], 7, layer_num), end=" ")
    
    # Outer thumb keys (52, 53, 54)
    print(format_key(*keys[52], 7, layer_num), end=" ")
    print(format_key(*keys[53], 7, layer_num), end=" ")
    print(" ", end="")
    print(format_key(*keys[54], 7, layer_num), end=" ")
    print(format_key(*keys[55], 7, layer_num), end=" ")
    
    for i in [56, 57, 58, 59, 60, 61]:
        print(format_key(*keys[i], 7, layer_num), end=" ")
    print()
    
    # Thumb cluster
    print("\n" + " "*20 + "╔" + "═"*52 + "╗")
    print(" "*20 + "║" + " "*20 + "THUMB CLUSTER" + " "*19 + "║")
    print(" "*20 + "╚" + "═"*52 + "╝")
    
    # Left thumb cluster
    print(" "*15, end="")
    for i in [62, 63, 64, 65, 66, 67]:
        if i < len(keys):
            print(format_key(*keys[i], 7, layer_num), end=" ")
    print(" "*10, end="")
    
    # Right thumb cluster
    for i in [68, 69, 70, 71, 72, 73]:
        if i < len(keys):
            print(format_key(*keys[i], 7, layer_num), end=" ")
    print()
    
    # Inner thumb keys
    print(" "*22, end="")
    for i in [74, 75, 76]:
        if i < len(keys):
            print(format_key(*keys[i], 7, layer_num), end=" ")
    print(" "*14, end="")
    for i in [77, 78, 79]:
        if i < len(keys):
            print(format_key(*keys[i], 7, layer_num), end=" ")
    print()
    
    print("\n" + "="*100)
    
    # Legend
    print("\n" + Colors.BOLD + "Legend:" + Colors.RESET)
    print(f"  {Colors.ALPHA}████{Colors.RESET} Letters  "
          f"{Colors.NUMBER}████{Colors.RESET} Numbers  "
          f"{Colors.FUNC}████{Colors.RESET} Function  "
          f"{Colors.MOD}████{Colors.RESET} Modifiers  "
          f"{Colors.NAV}████{Colors.RESET} Navigation")
    print(f"  {Colors.SYMBOL}████{Colors.RESET} Symbols  "
          f"{Colors.LAYER}████{Colors.RESET} Layers   "
          f"{Colors.MACRO}████{Colors.RESET} Macros    "
          f"{Colors.SPECIAL}████{Colors.RESET} Special    "
          f"{Colors.TRANS}████{Colors.RESET} Transparent")
    print()

def main():
    """Main function"""
    
    # Get the keymap file path
    script_dir = Path(__file__).parent.parent
    keymap_path = script_dir / "config" / "glove80.keymap"
    
    if not keymap_path.exists():
        print(f"Error: Keymap file not found at {keymap_path}")
        print("Please create a keymap first with 'make import'")
        sys.exit(1)
    
    # Get layer number from arguments
    layer_num = 0
    if len(sys.argv) > 1:
        try:
            layer_num = int(sys.argv[1])
        except ValueError:
            print(f"Invalid layer number: {sys.argv[1]}")
            sys.exit(1)
    
    # Parse and display the keymap
    keys = parse_keymap(keymap_path, layer_num)
    if keys:
        display_keymap(keys, layer_num)
        print(f"Keymap file: {keymap_path}")

if __name__ == "__main__":
    main()