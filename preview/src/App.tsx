import React, { useState } from 'react';
import KeyboardLayout from './components/KeyboardLayout';
import LayerSelector from './components/LayerSelector';
import keymapData from './data/keymap.json';
import { KeyboardData } from './types/keyboard';

const App: React.FC = () => {
  const data = keymapData as KeyboardData;
  const [currentLayer, setCurrentLayer] = useState(0);

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-gray-800 shadow-lg border-b border-gray-700">
        <div className="container mx-auto px-4 py-6">
          <h1 className="text-3xl font-bold text-center bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
            Glove80 Keyboard Layout
          </h1>
          <p className="text-center text-gray-400 mt-2">
            {data.metadata.left_keys + data.metadata.right_keys + data.metadata.left_thumb_keys + data.metadata.right_thumb_keys} keys • Split Ergonomic • ZMK Firmware
          </p>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Layer Selector */}
        <LayerSelector 
          layers={data.layers}
          currentLayer={currentLayer}
          onLayerChange={setCurrentLayer}
        />

        {/* Keyboard Layout */}
        <div className="bg-gray-800 rounded-xl shadow-2xl p-8 overflow-x-auto">
          <KeyboardLayout layer={data.layers[currentLayer]} />
        </div>

        {/* Legend */}
        <div className="mt-8 bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">Key Types</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            <LegendItem color="bg-gray-700" label="Regular Key" />
            <LegendItem color="bg-purple-700" label="Home Row Mod" />
            <LegendItem color="bg-green-700" label="Layer" />
            <LegendItem color="bg-orange-700" label="Macro" />
            <LegendItem color="bg-blue-700" label="Bluetooth" />
            <LegendItem color="bg-pink-700" label="Magic" />
            <LegendItem color="bg-indigo-700" label="RGB" />
            <LegendItem color="bg-red-700" label="System" />
            <LegendItem color="bg-teal-700" label="Output" />
            <LegendItem color="bg-gray-800 border-dashed" label="Transparent" />
          </div>
        </div>

        {/* Info */}
        <div className="mt-8 text-center text-gray-500 text-sm">
          <p>Generated from config/glove80.keymap</p>
          <p>Hover over keys to see full binding details</p>
        </div>
      </main>
    </div>
  );
};

// Legend Item Component
const LegendItem: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <div className="flex items-center gap-2">
    <div className={`w-8 h-8 ${color} rounded border-2 border-gray-600`} />
    <span className="text-sm text-gray-300">{label}</span>
  </div>
);

export default App;