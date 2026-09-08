import React from 'react';
import { apiGet } from '@/utils/api';
import type { Stakeholder } from '@/types';
import { chipStyle, chipRemoveStyle, dateInputStyle, dropdownStyle, dropdownItemStyle, sectionLabelStyle } from './styles';

interface StakeholderPickerProps {
  selected: Stakeholder[];
  onAdd: (s: Stakeholder) => void;
  onRemove: (id: string) => void;
  label?: string;
}

export default function StakeholderPicker({ selected, onAdd, onRemove, label = 'Stakeholders' }: StakeholderPickerProps) {
  const [query, setQuery] = React.useState('');
  const [allStakeholders, setAllStakeholders] = React.useState<Stakeholder[]>([]);
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const labelId = React.useId();

  React.useEffect(() => {
    apiGet<Stakeholder[]>('/api/stakeholders')
      .then((data) => setAllStakeholders(data ?? []))
      .catch(() => {});
  }, []);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allStakeholders.filter(
      (s) =>
        !selected.some((sel) => sel.id === s.id) &&
        (s.name?.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    );
  }, [query, allStakeholders, selected]);

  React.useEffect(() => {
    setDropdownOpen(filtered.length > 0 && query.trim().length > 0);
  }, [filtered, query]);

  React.useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const handleAdd = (s: Stakeholder) => {
    onAdd(s);
    setQuery('');
    setDropdownOpen(false);
  };

  return (
    <div>
      <label style={sectionLabelStyle} id={labelId}>
        {label}
      </label>

      {selected.length > 0 && (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px', marginBottom: '8px' }}
          aria-label="Selected stakeholders"
        >
          {selected.map((s) => (
            <span key={s.id} style={chipStyle}>
              {s.name ?? s.id}
              <button
                type="button"
                aria-label={`Remove stakeholder ${s.name ?? s.id}`}
                style={chipRemoveStyle}
                onClick={() => onRemove(s.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        ref={containerRef}
        style={{ position: 'relative', marginTop: selected.length > 0 ? 0 : 8 }}
        role="combobox"
        aria-expanded={dropdownOpen}
        aria-haspopup="listbox"
        aria-labelledby={labelId}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stakeholders..."
          aria-autocomplete="list"
          aria-controls={`${labelId}-listbox`}
          style={dateInputStyle}
        />
        {dropdownOpen && (
          <ul id={`${labelId}-listbox`} role="listbox" aria-label="Stakeholder suggestions" style={dropdownStyle}>
            {filtered.map((s) => (
              <li
                key={s.id}
                role="option"
                aria-selected={false}
                style={dropdownItemStyle}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleAdd(s);
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLLIElement).style.background = 'var(--color-surface-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLLIElement).style.background = ''; }}
              >
                {s.name ?? s.id}
                {s.role && (
                  <span style={{ marginLeft: '6px', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                    {s.role}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
