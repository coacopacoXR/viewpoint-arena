import React from 'react';
import { clsx } from 'clsx';

// Square icon button for the bottom call bar. Same visual vocabulary as the
// old dock button, one step smaller (36px) so the whole bar — call controls,
// view modes and leave — still fits the free canvas at 1280px wide.
const BarButton: React.FC<{
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
}> = ({ active, onClick, children, className, title }) => (
  <button
    onClick={onClick}
    title={title}
    className={clsx(
      "w-9 h-9 shrink-0 flex items-center justify-center rounded-sm transition-all duration-200 pointer-events-auto border",
      active
        ? "bg-black text-white border-black shadow-inner"
        : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:text-black hover:shadow-sm",
      className
    )}
  >
    {children}
  </button>
);

export default BarButton;
