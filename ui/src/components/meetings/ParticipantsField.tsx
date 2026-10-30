import type { MeetingParticipant } from '@/types';
import StakeholderPicker from '@/components/task-form/StakeholderPicker';
import { addParticipant } from '@/utils/meetingParticipants';

const id = (p: MeetingParticipant) => p.ref ?? `name:${p.name}`;

/** Who is expected at a meeting: stakeholders, and any other name typed in. */
export function ParticipantsField({ value, onChange }: { value: MeetingParticipant[]; onChange: (next: MeetingParticipant[]) => void }) {
  return (
    <div>
      <StakeholderPicker
        label="Participants"
        placeholder="Search stakeholders, or type a name and press Enter"
        selected={value.map((p) => ({ id: id(p), name: p.name }))}
        onAdd={(s) => onChange(addParticipant(value, { name: s.name ?? s.id, ref: s.id }))}
        onAddName={(name) => onChange(addParticipant(value, { name }))}
        onRemove={(removed) => onChange(value.filter((p) => id(p) !== removed))}
      />
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
        Optional. Who you expect. The analysis treats them as expected, not as proof of who came.
      </p>
    </div>
  );
}
