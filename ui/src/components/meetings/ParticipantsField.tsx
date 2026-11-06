import { useLanguage } from '@/i18n/LanguageProvider';
import type { MeetingParticipant } from '@/types';
import StakeholderPicker from '@/components/task-form/StakeholderPicker';
import { addParticipant } from '@/utils/meetingParticipants';

const id = (p: MeetingParticipant) => p.ref ?? `name:${p.name}`;

/** Who is expected at a meeting: stakeholders, and any other name typed in. */
export function ParticipantsField({ value, onChange }: { value: MeetingParticipant[]; onChange: (next: MeetingParticipant[]) => void }) {
  const { t } = useLanguage();
  return (
    <div>
      <StakeholderPicker
        label={t('participantsField.participants')}
        placeholder={t('participantsField.searchStakeholdersOrTypeA')}
        selected={value.map((p) => ({ id: id(p), name: p.name }))}
        onAdd={(s) => onChange(addParticipant(value, { name: s.name ?? s.id, ref: s.id }))}
        onAddName={(name) => onChange(addParticipant(value, { name }))}
        onRemove={(removed) => onChange(value.filter((p) => id(p) !== removed))}
      />
      <p className="gtd-field__hint" style={{ marginTop: 'var(--space-1)' }}>
        {t('participantsField.optionalWhoYouExpectThe')}
      </p>
    </div>
  );
}
