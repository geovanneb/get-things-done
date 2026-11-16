import { useLanguage } from '@/i18n/LanguageProvider';
import Badge from '@/components/common/Badge';
import type { OutputTemplate } from '@/types';
import { selectStyle } from './styles';
import IconRemoveButton from './IconRemoveButton';
import TextDeliverableAccordion from './TextDeliverableAccordion';

export interface DeliverableItem {
  id?: string;
  format?: string;
  template_ref?: string;
  /** Instead of a template: the task file this deliverable answers in (empty until one is picked). */
  fill_file?: string;
  status?: 'pending' | 'in_progress' | 'complete' | 'cancelled';
  file_path?: string;
}

interface DeliverableRowProps {
  item: DeliverableItem;
  index: number;
  templates: OutputTemplate[];
  onChange: (patch: Partial<DeliverableItem>) => void;
  onRemove: () => void;
  /**
   * The task's files, offered for "Answer in an attached file". Left out where a task has no files of its own
   * (routines): the option is not offered there.
   */
  files?: string[];
  /** Shown in place of the file select when no file is attached yet: where to add one. */
  noFilesHint?: string;
}

/** The select value for "Answer in an attached file"; never a template id (those are slugs). */
const FILL = ':fill';

/** The file's type, lowercase, as the deliverable's format; '' when it has none. */
function fileType(name: string): string {
  const m = name.match(/\.([A-Za-z0-9]{1,10})$/);
  return m ? m[1]!.toLowerCase() : '';
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
export default function DeliverableRow({ item, index, templates, onChange, onRemove, files, noFilesHint }: DeliverableRowProps) {
  const { t } = useLanguage();
  const isComplete = item.status === 'complete';
  const outputUrl = item.file_path ? `/api/workspace/files/${item.file_path}` : null;
  const hasStatus = !!item.status;

  const filling = item.fill_file !== undefined;
  // Files without a type cannot be answered in: the type is the deliverable's format.
  const fillable = (files ?? []).filter((name) => fileType(name));
  // A picked file that is no longer attached is still shown, so the choice is not lost silently.
  const fillOptions = item.fill_file && !fillable.includes(item.fill_file) ? [item.fill_file, ...fillable] : fillable;

  const selectedTemplate = filling ? undefined : templates.find((t) => t.id === item.template_ref);
  // Prefer the template's format; fall back to the stored one for legacy
  // deliverables saved before the template became the single source.
  const effectiveFormat = filling ? (item.fill_file ? fileType(item.fill_file) : undefined) : selectedTemplate?.format ?? item.format;

  const handleTemplateChange = (templateId: string) => {
    if (templateId === FILL) {
      // With one attached file there is nothing to choose.
      const only = fillable.length === 1 ? fillable[0]! : '';
      onChange({ template_ref: undefined, fill_file: only, format: only ? fileType(only) : undefined });
      return;
    }
    if (!templateId) {
      onChange({ template_ref: undefined, fill_file: undefined });
      return;
    }
    const template = templates.find((t) => t.id === templateId);
    onChange({
      template_ref: templateId,
      fill_file: undefined,
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
              {isComplete ? t('deliverableRow.complete') : item.status === 'in_progress' ? t('deliverableRow.inProgress') : item.status === 'cancelled' ? t('deliverableRow.cancelled') : t('deliverableRow.pending')}
            </Badge>
          )}
          <div style={{ flex: 1 }} />
          {outputUrl && effectiveFormat?.toUpperCase() !== 'TXT' && (
            <a
              href={outputUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={t('deliverableRow.openOutput')}
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
              {t('deliverableRow.openOutput')}
            </a>
          )}
          <IconRemoveButton onClick={onRemove} aria-label={t('deliverableRow.removeDeliverable', { value: index + 1 })} title={t('deliverableRow.removeDeliverable2')} />
        </div>
      )}

      {/* TXT / MD accordion: inline text (Markdown rendered as a preview) with copy button */}
      {['TXT', 'MD'].includes(effectiveFormat?.toUpperCase() ?? '') && item.file_path && (
        <TextDeliverableAccordion filePath={item.file_path} markdown={effectiveFormat?.toUpperCase() === 'MD'} />
      )}

      {/* Output template select — the format comes with the template */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <select
          value={filling ? FILL : item.template_ref ?? ''}
          onChange={(e) => handleTemplateChange(e.target.value)}
          style={{ ...selectStyle, flex: 1 }}
          aria-label={t('deliverableRow.deliverableOutputTemplate', { value: index + 1 })}
          title={t('deliverableRow.outputTemplate')}
        >
          <option value="">{t('deliverableRow.selectAnOutputTemplate')}</option>
          {files || filling ? (
            <>
              <optgroup label={t('deliverableRow.outputTemplates')}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.format.toUpperCase()})
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('deliverableRow.noTemplate')}>
                <option value={FILL}>{t('deliverableRow.answerInAnAttachedFile')}</option>
              </optgroup>
            </>
          ) : templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.format.toUpperCase()})
            </option>
          ))}
        </select>
        {effectiveFormat && (
          <span style={{ display: 'flex', flexShrink: 0 }} title={filling ? t('deliverableRow.formatOfTheAttachedFile') : t('deliverableRow.formatDefinedByTheOutput')}>
            <Badge size="sm">{effectiveFormat.toUpperCase()}</Badge>
          </span>
        )}
        {!hasStatus && !item.id && (
          <IconRemoveButton onClick={onRemove} aria-label={t('deliverableRow.removeDeliverable', { value: index + 1 })} title={t('deliverableRow.removeDeliverable2')} />
        )}
      </div>

      {/* Answer in an attached file: which of the task's files */}
      {filling && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {fillOptions.length > 0 ? (
            <select
              value={item.fill_file ?? ''}
              onChange={(e) => onChange({ fill_file: e.target.value, format: fileType(e.target.value) || undefined })}
              style={selectStyle}
              aria-label={t('deliverableRow.deliverableFileToAnswerIn', { value: index + 1 })}
              aria-invalid={item.fill_file ? undefined : true}
            >
              <option value="">{t('deliverableRow.pickTheFileToAnswerIn')}</option>
              {fillOptions.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          ) : (
            noFilesHint && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text)' }}>{noFilesHint}</span>
          )}
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('deliverableRow.answerInHint')}</span>
        </div>
      )}

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
