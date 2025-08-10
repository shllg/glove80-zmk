import React from 'react';
import { Layer, KeyRow } from '../types/keyboard';
import Key from './Key';

interface KeyboardLayoutProps {
  layer: Layer;
}

const KeyboardLayout: React.FC<KeyboardLayoutProps> = ({ layer }) => {
  const renderRow = (row: KeyRow, size: 'sm' | 'md' | 'lg' | 'thumb' = 'md') => {
    return row.map((key, index) => (
      <Key key={index} keyData={key} size={size} />
    ));
  };

  const renderSection = (rows: KeyRow[], isThumb: boolean = false) => {
    return rows.map((row, rowIndex) => (
      <div 
        key={rowIndex} 
        className={`flex gap-1 ${isThumb ? 'justify-center' : ''}`}
      >
        {renderRow(row, isThumb ? 'thumb' : rowIndex === 0 ? 'sm' : 'md')}
      </div>
    ));
  };

  return (
    <div className="flex justify-center gap-12 p-8">
      {/* Left Half */}
      <div className="flex flex-col gap-8">
        {/* Left Main Keys */}
        <div className="flex flex-col gap-1">
          {renderSection(layer.left)}
        </div>
        
        {/* Left Thumb Cluster */}
        <div className="flex flex-col gap-2 mt-4">
          <div className="text-xs text-gray-500 text-center mb-2">Left Thumb</div>
          {renderSection(layer.left_thumb, true)}
        </div>
      </div>

      {/* Right Half */}
      <div className="flex flex-col gap-8">
        {/* Right Main Keys */}
        <div className="flex flex-col gap-1">
          {renderSection(layer.right)}
        </div>
        
        {/* Right Thumb Cluster */}
        <div className="flex flex-col gap-2 mt-4">
          <div className="text-xs text-gray-500 text-center mb-2">Right Thumb</div>
          {renderSection(layer.right_thumb, true)}
        </div>
      </div>
    </div>
  );
};

export default KeyboardLayout;