import React from 'react';
import { Key as KeyType } from '../types/keyboard';

interface KeyProps {
  keyData: KeyType;
  size?: 'sm' | 'md' | 'lg' | 'thumb';
}

const Key: React.FC<KeyProps> = ({ keyData, size = 'md' }) => {
  // Size classes
  const sizeClasses = {
    sm: 'w-12 h-10 text-xs',
    md: 'w-14 h-14 text-sm',
    lg: 'w-16 h-16 text-base',
    thumb: 'w-16 h-12 text-sm'
  };

  // Color classes based on key type
  const colorClasses: Record<string, string> = {
    regular: 'bg-gray-700 hover:bg-gray-600 text-gray-100 border-gray-600',
    trans: 'bg-gray-800 hover:bg-gray-700 text-gray-500 border-gray-700 border-dashed',
    none: 'bg-gray-900 text-gray-700 border-gray-800 opacity-50',
    bluetooth: 'bg-blue-700 hover:bg-blue-600 text-blue-100 border-blue-600',
    hrm: 'bg-purple-700 hover:bg-purple-600 text-purple-100 border-purple-600',
    layer: 'bg-green-700 hover:bg-green-600 text-green-100 border-green-600',
    magic: 'bg-pink-700 hover:bg-pink-600 text-pink-100 border-pink-600',
    macro: 'bg-orange-700 hover:bg-orange-600 text-orange-100 border-orange-600',
    rgb: 'bg-indigo-700 hover:bg-indigo-600 text-indigo-100 border-indigo-600',
    system: 'bg-red-700 hover:bg-red-600 text-red-100 border-red-600',
    output: 'bg-teal-700 hover:bg-teal-600 text-teal-100 border-teal-600'
  };

  const baseClasses = 'rounded-lg border-2 flex flex-col items-center justify-center font-mono transition-all duration-200 transform hover:scale-105 hover:shadow-lg cursor-default select-none';
  
  const keyClass = colorClasses[keyData.class] || colorClasses.regular;

  // Handle empty keys
  if (keyData.type === 'none' && !keyData.label) {
    return (
      <div className={`${sizeClasses[size]} opacity-0 pointer-events-none`} />
    );
  }

  // Format label for display
  const renderLabel = () => {
    if (keyData.type === 'hold_tap' && keyData.hold && keyData.tap) {
      return (
        <>
          <span className="text-xs opacity-75">{keyData.tap}</span>
          <span className="text-xs font-bold">{keyData.hold}</span>
        </>
      );
    }
    
    // Split long labels
    if (keyData.label.length > 6) {
      return <span className="text-xs">{keyData.label}</span>;
    }
    
    return <span>{keyData.label}</span>;
  };

  return (
    <div
      className={`${baseClasses} ${sizeClasses[size]} ${keyClass}`}
      title={keyData.raw}
    >
      {renderLabel()}
    </div>
  );
};

export default Key;