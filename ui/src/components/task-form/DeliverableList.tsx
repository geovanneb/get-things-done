import { useApi } from '@/hooks/useApi';
import type { OutputTemplate } from '@/types';
import { sectionLabelStyle } from './styles';
import AddButton from './AddButton';
import DeliverableRow, { DeliverableItem } from './DeliverableRow';

interface DeliverableListProps {
  items: DeliverableItem[];
  onChange: (index: number, patch: Partial<DeliverableItem>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  label?: string;
  emptyText?: string;
}

/**
 * Deliverables section shared by the New Task modal and the Edit Task
 * overlay: a header with an "Add" button, and one DeliverableRow per item.
 */
export default function DeliverableList({
  items,
  onChange,
  onRemove,
  onAdd,
  label = 'Deliverables',
  emptyText = 'No deliverables defined.',
}: DeliverableListProps) {
  const { data: templates } = useApi<OutputTemplate[]>('/api/outputs/templates');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0, ...sectionLabelStyle }}>{label}</h3>
        <AddButton onClick={onAdd} />
      </div>
      {items.length === 0 ? (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', fontStyle: 'italic', margin: 0 }}>
          {emptyText}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item, i) => (
            <DeliverableRow
              key={item.id ?? i}
              item={item}
              index={i}
              templates={templates ?? []}
              onChange={(patch) => onChange(i, patch)}
              onRemove={() => onRemove(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
