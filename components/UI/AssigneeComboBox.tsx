import React, { useState, useRef, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Plus } from 'lucide-react';
import { usePeopleOptions } from '../../lib/people';

interface AssigneeComboBoxProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}

// Combo box for assignee selection. Replaces the old hardcoded <select> with
// a list assembled from the people currently in the room, plus free text.
// Typing a name that matches nobody offers "Add <name> to the team", which
// is simply used as typed.
const AssigneeComboBox: React.FC<AssigneeComboBoxProps> = ({
  value,
  onChange,
  className,
  placeholder = 'Unassigned',
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const options = usePeopleOptions(value || undefined);

  // Filter options by query.
  const filtered = query.trim()
    ? options.filter((o) => o.source === 'unassigned' || o.name.toLowerCase().includes(query.toLowerCase()))
    : options;

  // "Add to team" entry appears when the query matches nobody exactly.
  const exactMatch = query.trim()
    ? options.some((o) => o.name.toLowerCase() === query.trim().toLowerCase())
    : true;
  const showAddOption = query.trim().length > 0 && !exactMatch;

  const totalItems = filtered.length + (showAddOption ? 1 : 0);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Scroll highlighted item into view.
  useEffect(() => {
    if (highlightIdx < 0 || !listRef.current) return;
    const el = listRef.current.children[highlightIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx]);

  const selectValue = useCallback((name: string) => {
    onChange(name === 'Unassigned' ? '' : name);
    setQuery('');
    setOpen(false);
    setHighlightIdx(-1);
  }, [onChange]);

  // Typing a name simply uses it. There is no stored roster to add it to —
  // per-review people lists were removed on request (user, 2026-09-23);
  // managing people is the admin panel's job (docs/plan/11).
  const handleUseTypedName = useCallback(() => {
    const name = query.trim();
    if (!name) return;
    selectValue(name);
  }, [query, selectValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); setHighlightIdx(0); return; }
      setHighlightIdx((i) => Math.min(i + 1, totalItems - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (highlightIdx < 0) return;
      if (highlightIdx < filtered.length) {
        selectValue(filtered[highlightIdx].name);
      } else if (showAddOption) {
        handleUseTypedName();
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setHighlightIdx(-1);
    }
  };

  const displayValue = value || '';

  return (
    <div ref={containerRef} className={clsx('relative', className)}>
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="text"
          value={open ? query : displayValue}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
            setHighlightIdx(-1);
          }}
          onFocus={() => { setOpen(true); setQuery(''); setHighlightIdx(-1); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="text-xs text-gray-800 font-medium border-b border-gray-200 focus:border-black outline-none py-1 bg-transparent flex-1 min-w-0"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
        />
        <button
          type="button"
          onClick={() => { setOpen((v) => !v); setQuery(''); setHighlightIdx(-1); inputRef.current?.focus(); }}
          className="text-gray-400 hover:text-gray-600 shrink-0"
          tabIndex={-1}
          aria-label="Toggle assignee list"
        >
          <ChevronDown size={12} />
        </button>
      </div>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute z-50 left-0 top-full mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded shadow-lg"
        >
          {filtered.length === 0 && !showAddOption && (
            <li className="px-3 py-2 text-xs text-gray-400 italic">No matches</li>
          )}
          {filtered.map((opt, idx) => (
            <li
              key={opt.name}
              role="option"
              aria-selected={highlightIdx === idx}
              onClick={() => selectValue(opt.name)}
              onMouseEnter={() => setHighlightIdx(idx)}
              className={clsx(
                'px-3 py-1.5 text-xs cursor-pointer flex items-center gap-2',
                highlightIdx === idx ? 'bg-gray-100' : 'bg-white hover:bg-gray-50',
                opt.name === 'Unassigned' ? 'text-gray-400 italic' : 'text-gray-800',
              )}
            >
              {opt.inRoom && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
              <span className="truncate">{opt.name}</span>
            </li>
          ))}
          {showAddOption && (
            <li
              role="option"
              aria-selected={highlightIdx === filtered.length}
              onClick={handleUseTypedName}
              onMouseEnter={() => setHighlightIdx(filtered.length)}
              className={clsx(
                'px-3 py-1.5 text-xs cursor-pointer flex items-center gap-2 border-t border-gray-100',
                highlightIdx === filtered.length ? 'bg-emerald-50 text-emerald-700' : 'bg-white text-emerald-600 hover:bg-emerald-50',
              )}
            >
              <Plus size={10} className="shrink-0" />
              <span className="truncate">Add &ldquo;{query.trim()}&rdquo; to the team</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
};

export default AssigneeComboBox;
