/**
 * Example usage of the exported keymap data with TypeScript
 */

import type { KeyboardData, Layer, Key } from '../types/keyboard';
import keymapData from '../keymap.json';

// Type the imported data
const keyboard: KeyboardData = keymapData as KeyboardData;

// Example: Get all layers
function getAllLayerNames(): string[] {
  return keyboard.layers.map(layer => layer.name);
}

// Example: Find a specific layer
function getLayer(name: string): Layer | undefined {
  return keyboard.layers.find(layer => layer.name === name);
}

// Example: Get all home row mods from a layer
function getHomeRowMods(layerName: string): Key[] {
  const layer = getLayer(layerName);
  if (!layer) return [];
  
  const hrms: Key[] = [];
  
  // Check all keys in all sections
  [...layer.left, ...layer.right, ...layer.left_thumb, ...layer.right_thumb].forEach(row => {
    row.forEach(key => {
      if (key.type === 'hold_tap' && key.class === 'hrm') {
        hrms.push(key);
      }
    });
  });
  
  return hrms;
}

// Example: Count key types in a layer
function countKeyTypes(layerName: string): Record<string, number> {
  const layer = getLayer(layerName);
  if (!layer) return {};
  
  const counts: Record<string, number> = {};
  
  [...layer.left, ...layer.right, ...layer.left_thumb, ...layer.right_thumb].forEach(row => {
    row.forEach(key => {
      counts[key.type] = (counts[key.type] || 0) + 1;
    });
  });
  
  return counts;
}

// Example: Get a specific key at position
function getKeyAtPosition(layerName: string, section: keyof Layer, row: number, col: number): Key | undefined {
  const layer = getLayer(layerName);
  if (!layer) return undefined;
  
  const sectionData = layer[section];
  if (!Array.isArray(sectionData)) return undefined;
  
  return sectionData[row]?.[col];
}

// Example React component usage
export function KeyboardVisualization({ data }: { data: KeyboardData }) {
  const [selectedLayer, setSelectedLayer] = React.useState(0);
  const layer = data.layers[selectedLayer];
  
  return (
    <div>
      <h1>Glove80 Layout: {layer.name}</h1>
      
      <div className="layer-selector">
        {data.layers.map((l, idx) => (
          <button 
            key={idx}
            onClick={() => setSelectedLayer(idx)}
            className={idx === selectedLayer ? 'active' : ''}
          >
            {l.name}
          </button>
        ))}
      </div>
      
      <div className="keyboard">
        <div className="left-half">
          {layer.left.map((row, rowIdx) => (
            <div key={rowIdx} className="row">
              {row.map((key, colIdx) => (
                <KeyComponent key={colIdx} keyData={key} />
              ))}
            </div>
          ))}
          
          <div className="thumb-cluster">
            {layer.left_thumb.map((row, rowIdx) => (
              <div key={rowIdx} className="thumb-row">
                {row.map((key, colIdx) => (
                  <KeyComponent key={colIdx} keyData={key} />
                ))}
              </div>
            ))}
          </div>
        </div>
        
        <div className="right-half">
          {/* Similar structure for right side */}
        </div>
      </div>
    </div>
  );
}

function KeyComponent({ keyData }: { keyData: Key }) {
  return (
    <div 
      className={`key ${keyData.class}`}
      title={keyData.raw}
    >
      <span className="label">{keyData.label}</span>
      {keyData.hold && keyData.tap && (
        <span className="hold-tap">
          {keyData.tap}/{keyData.hold}
        </span>
      )}
    </div>
  );
}

// Export for use in other files
export { getAllLayerNames, getLayer, getHomeRowMods, countKeyTypes, getKeyAtPosition };