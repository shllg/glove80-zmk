/**
 * TypeScript type definitions for Glove80 keyboard data
 * Generated from ZMK keymap export
 */

export interface KeyboardData {
  keyboard: string;
  total_keys: number;
  layers: Layer[];
  layout_type: 'split' | 'unibody';
  metadata: KeyboardMetadata;
}

export interface KeyboardMetadata {
  left_keys: number;
  right_keys: number;
  left_thumb_keys: number;
  right_thumb_keys: number;
}

export interface Layer {
  name: string;
  left: KeyRow[];
  right: KeyRow[];
  left_thumb: KeyRow[];
  right_thumb: KeyRow[];
}

export type KeyRow = Key[];

export interface Key {
  raw: string;
  type: KeyType;
  label: string;
  hold?: string | null;
  tap?: string | null;
  class: KeyClass;
}

export type KeyType = 
  | 'key'
  | 'transparent'
  | 'none'
  | 'bluetooth'
  | 'hold_tap'
  | 'layer'
  | 'magic'
  | 'macro'
  | 'rgb'
  | 'system'
  | 'output';

export type KeyClass = 
  | 'regular'
  | 'trans'
  | 'none'
  | 'bluetooth'
  | 'hrm'
  | 'layer'
  | 'magic'
  | 'macro'
  | 'rgb'
  | 'system'
  | 'output';

// Layout structure definitions for reference
export interface LayoutStructure {
  left: SectionLayout;
  right: SectionLayout;
  left_thumb: ThumbLayout;
  right_thumb: ThumbLayout;
}

export interface SectionLayout {
  rows: RowDefinition[];
}

export interface ThumbLayout {
  rows: ThumbRowDefinition[];
}

export interface RowDefinition {
  start: number;
  count: number;
}

export interface ThumbRowDefinition {
  positions: number[];
}

// Physical key position constants
export const TOTAL_KEYS = 80;
export const LEFT_MAIN_KEYS = 26;
export const RIGHT_MAIN_KEYS = 26;
export const LEFT_THUMB_KEYS = 14;
export const RIGHT_THUMB_KEYS = 14;

// Helper type for key position (0-79)
export type KeyPosition = number;

// Helper type for layer index
export type LayerIndex = number;

// Re-export for convenience
export type Glove80Data = KeyboardData;