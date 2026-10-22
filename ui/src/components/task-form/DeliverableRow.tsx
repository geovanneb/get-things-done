import Badge from '@/components/common/Badge';
import type { OutputTemplate } from '@/types';
import { selectStyle } from './styles';
import IconRemoveButton from './IconRemoveButton';
import TextDeliverableAccordion from './TextDeliverableAccordion';

export interface DeliverableItem {
  id?: string;
  format?: string;
  template_ref?: string;
  status?: 'pending' | 'in_progress' | 'complete' | 'cancelled';
  file_path?: string;
}

interface DeliverableRowProps {
  item: DeliverableItem;
  index: number;
  templates: OutputTemplate[];
  onChange: (patch: Partial<DeliverableItem>) => void;
  onRemove: () => void;
}

/**
 * One deliverable row: a single output-template select. The file format is
 * not chosen here — it is a property of the template (set on the Outputs
 * screen), so picking a template also sets the deliverable's format, shown
 * read-only beside the select. Status badge, "Open output" link, TXT
 * preview, and file path only appear once that data exists (never for a
 * brand-new, unsaved task) — everything else about the row is identical in
 * the New Task modal and the Edit Task overlay.
 */
export default function DeliverableRow({ item, index, templates, onChange, onRemove }: DeliverableRowProps) {
  const isComplete = item.status === 'complete';
  const outputUrl = item.file_path ? `/api/workspace/files/${item.file_path}` : null;
  const hasStatus = !!item.status;

  const selectedTemplate = templates.find((t) => t.id === item.template_ref);
  // Prefer the template's format; fall back to the stored one for legacy
  // deliverables saved before the template became the single source.
  const effectiveFormat = selectedTemplate?.format ?? item.format;

  const handleTemplateChange = (templateId: string) => {
    if (!templateId) {
      onChange({ template_ref: undefined });
      return;
    }
    const template = templates.find((t) => t.id === templateId);
    onChange({
      template_ref: templateId,
      // The schema stores formats lowercase.
      format: template ? template.format.toLowerCase() : item.format,
    });
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: hasStatus ? '12px 14px' : 0,
      background: hasStatus ? 'var(--color-bg)' : 'transparent',
      border: hasStatus
        ? `1px solid ${isComplete ? 'color-mix(in oklch, var(--color-success) 30%, var(--color-border))' : 'var(--color-border)'}`
        : 'none',
      borderRadius: hasStatus ? 'var(--radius-md)' : 0,
    }}>
      {/* Row 1: id/status badges + output link + remove — only meaningful once the deliverable has state */}
      {(hasStatus || item.id) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {item.id && (
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {item.id}
            </span>
          )}
          {hasStatus && (
            <Badge size="sm" variant={isComplete ? 'success' : item.status === 'in_progress' ? 'warning' : 'default'}>
              {isComplete ? 'Complete' : item.status === 'in_progress' ? 'In progress' : item.status === 'cancelled' ? 'Cancelled' : 'Pending'}
            </Badge>
          )}
          <div style={{ flex: 1 }} />
          {outputUrl && effectiveFormat?.toUpperCase() !== 'TXT' && (
            <a
              href={outputUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open output"
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                fontSize: 'var(--text-xs)', fontWeight: 600,
                color: 'var(--color-accent)',
                textDecoration: 'none',
                border: '1px solid var(--color-accent)',
                borderRadius: 'var(--radius-sm)',
                padding: '3px 8px',
                flexShrink: 0,
                transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = 'var(--color-accent-subtle)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = 'transparent'; }}
            >
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                <path d="M2 9L9 2M5 2h4v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Open output
            </a>
          )}
          <IconRemoveButton onClick={onRemove} aria-label={`Remove deliverable ${index + 1}`} title="Remove deliverable" />
        </div>
      )}

      {/* TXT / MD accordion: inline text (Markdown rendered as a preview) with copy button */}
      {['TXT', 'MD'].includes(effectiveFormat?.toUpperCase() ?? '') && item.file_path && (
        <TextDeliverableAccordion filePath={item.file_path} markdown={effectiveFormat?.toUpperCase() === 'MD'} />
      )}

      {/* Output template select — the format comes with the template */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <select
          value={item.template_ref ?? ''}
          onChange={(e) => handleTemplateChange(e.target.value)}
          style={{ ...selectStyle, flex: 1 }}
          aria-label={`Deliverable ${index + 1} output template`}
          title="Output template"
        >
          <option value="">Select an output template...</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.format.toUpperCase()})
            </option>
          ))}
        </select>
        {effectiveFormat && (
          <span style={{ display: 'flex', flexShrink: 0 }} title="Format defined by the output template">
            <Badge size="sm">{effectiveFormat.toUpperCase()}</Badge>
          </span>
        )}
        {!hasStatus && !item.id && (
          <IconRemoveButton onClick={onRemove} aria-label={`Remove deliverable ${index + 1}`} title="Remove deliverable" />
        )}
      </div>

      {/* File path (when set) */}
      {item.file_path && (
        <div style={{
          fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
          color: 'var(--color-text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={item.file_path}>
          {item.file_path}
        </div>
      )}
    </div>
  );
}
