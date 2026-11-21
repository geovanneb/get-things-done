import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import { Checkbox } from '@/components/common/Input';
import type { Stakeholder } from '@/types';

/**
 * Stakeholders a draft offers as the audience (e.g. the people of the meeting a deliverable comes from), each with a
 * box to tick. None is ticked at first: who was in a meeting is not always who the deliverable is for. Ticking adds
 * the stakeholder to the task's Stakeholders, unticking removes them.
 */
export default function SuggestedStakeholders({ suggested, selected, onToggle }: {
  suggested: Stakeholder[];
  selected: Pick<Stakeholder, 'id'>[];
  onToggle: (stakeholder: Stakeholder, on: boolean) => void;
}) {
  const { t } = useLanguage();
  const headingId = React.useId();
  if (!suggested.length) return null;
  return (
    <div role="group" aria-labelledby={headingId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div>
        <div id={headingId} className="gtd-field__label">{t('suggestedStakeholders.fromTheMeeting')}</div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('suggestedStakeholders.tickWhoItIsFor')}</div>
      </div>
      {suggested.map((s) => (
        <Checkbox key={s.id} checked={selected.some((x) => x.id === s.id)} onChange={(on) => onToggle(s, on)}
          label={s.name} {...(s.role ? { description: s.role } : {})} />
      ))}
    </div>
  );
}
