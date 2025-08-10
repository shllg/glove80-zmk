import React from 'react';
import { Layer } from '../types/keyboard';

interface LayerSelectorProps {
  layers: Layer[];
  currentLayer: number;
  onLayerChange: (index: number) => void;
}

const LayerSelector: React.FC<LayerSelectorProps> = ({ layers, currentLayer, onLayerChange }) => {
  return (
    <div className="flex justify-center gap-2 mb-8">
      {layers.map((layer, index) => (
        <button
          key={index}
          onClick={() => onLayerChange(index)}
          className={`
            px-6 py-3 rounded-lg font-semibold transition-all duration-200 transform
            ${currentLayer === index 
              ? 'bg-blue-600 text-white scale-105 shadow-lg' 
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white hover:scale-105'
            }
          `}
        >
          {layer.name}
        </button>
      ))}
    </div>
  );
};

export default LayerSelector;