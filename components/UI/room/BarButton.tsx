import React from 'react';
import { clsx } from 'clsx';

// Square icon button for the bottom call bar. Same visual vocabulary as the
// old dock button, one step smaller (36px) so the whole bar — call controls,
// view modes and leave — still fits the free canvas at 1280px wide.
//
// `data-testid` is a named prop rather than a spread of the rest, because the bar's
// controls are found in tests by their title as often as by their testid and a `...rest`
// would quietly start forwarding anything a caller typed at one of them.
const BarButton: React.FC<{
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
  'data-testid'?: string;
}> = ({ active, onClick, children, className, title, ...rest }) => (
  <button
    onClick={onClick}
    title={title}
    data-testid={rest['data-testid']}
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
