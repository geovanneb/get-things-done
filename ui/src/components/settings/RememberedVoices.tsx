import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Notice from '@/components/common/Notice';
import Toggle from '@/components/common/Toggle';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import { apiDelete, apiPost } from '@/utils/api';
import { speechLength, voiceTag } from '@/utils/voiceprints';
import type { Voiceprints } from '@/types';

const hintStyle: React.CSSProperties = { margin: 0, maxWidth: 560, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' };

/**
 * Settings > Transcription, Recognize known voices: the switch (off by default), the voices remembered on this
 * computer with their consent, Forget and Forget all, and voices of a workspace that was moved.
 */
export function RememberedVoices({ on, speakersOn, saving, onToggle }: { on: boolean; speakersOn: boolean; saving: boolean; onToggle: (on: boolean) => void }) {
  const confirm = useConfirm();
  // Also when the transcription settings change: whether it is on, and whether the speaker model is here.
  const version = useDataVersion('voiceprints');
  const settingsVersion = useDataVersion('transcription');
  const { data, error, refetch } = useApi<Voiceprints>('/api/voiceprints', [version, settingsVersion]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const act = async (what: () => Promise<unknown>) => {
    setNotice(null);
    setBusy(true);
    try { await what(); refetch(); } catch (err) { setNotice((err as Error).message); } finally { setBusy(false); }
  };
  const forget = async (ref: string, name: string) => {
    if (!(await confirm({ title: `Forget ${name}'s voice?`, message: 'The app stops suggesting this name. Names already given in transcripts stay. Copies in backups of this computer (such as Time Machine) are not removed.', confirmLabel: 'Forget voice', tone: 'danger' }))) return;
    await act(() => apiDelete(`/api/voiceprints/${encodeURIComponent(ref)}`));
  };
  const forgetAll = async () => {
    if (!(await confirm({ title: 'Forget every remembered voice?', message: 'The app stops suggesting names for this workspace. Names already given stay. Backups of this computer are not changed.', confirmLabel: 'Forget all', tone: 'danger' }))) return;
    await act(() => apiPost('/api/voiceprints/forget-all'));
  };

  if (error) return <p role="alert" style={{ ...hintStyle, color: 'var(--color-critical)' }}>{error}</p>;
  if (!data) return null;
  const blocked = !data.speaker_model ? 'Download the speaker model above first.' : !speakersOn ? 'Turn on Tell speakers apart first.' : null;

  return (
    <section aria-labelledby="remembered-voices" className="gtd-stack" style={{ gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Toggle id="recognize-voices" label="Recognize known voices" checked={on} disabled={saving || (Boolean(blocked) && !on)} onChange={onToggle} />
        <span id="remembered-voices" style={{ fontWeight: 600 }}>Recognize known voices</span>
      </div>
      <p style={hintStyle}>
        Suggests a speaker&apos;s name when a transcript has a voice you asked the app to remember, with that person&apos;s consent.
        It only suggests: nothing is named until you choose Use. Voices stay on this computer, outside the workspace, and are
        never shared or given to AI tools. A voice can be wrong for someone it never heard, so check each suggestion.
        See and manage a stakeholder&apos;s voice on their page.
      </p>
      {blocked && <p role="note" style={hintStyle}>{blocked}</p>}
      {notice && <Notice tone="critical" title="That did not work.">{notice}</Notice>}
      {data.moved.map((m) => (
        <Notice key={m.key} tone="info" title="Voices of a workspace that was moved"
          action={<span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => apiPost(`/api/voiceprints/moved/${m.key}/relink`))}>Use them here</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => apiDelete(`/api/voiceprints/moved/${m.key}`))}>Forget them</Button>
          </span>}>
          {m.prints.length} {m.prints.length === 1 ? 'voice was' : 'voices were'} remembered for <code style={{ overflowWrap: 'anywhere' }}>{m.workspace}</code>, which is
          not there any more. If this workspace is that folder, moved, use them here. A copy of a workspace never gets them by itself.
        </Notice>
      ))}
      {data.prints.length === 0
        ? <p style={{ ...hintStyle, color: 'var(--color-text-muted)' }}>No voice is remembered. After naming a speaker with a stakeholder, choose Remember voice next to the name.</p>
        : (
          <ul aria-label="Remembered voices" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', maxWidth: 640 }}>
            {data.prints.map((p) => {
              const tag = voiceTag(p);
              return (
                <li key={p.ref} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                  <span style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontWeight: 600 }}>
                      {/* A stakeholder's voice is managed on their page; yours here. */}
                      {p.ref !== 'me' && p.stakeholder ? <Link to={`/stakeholders/${p.ref}`} className="gtd-link">{p.name}</Link> : p.name}
                      {' '}<span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>{p.ref === 'me' ? '' : p.ref}</span>
                    </span>
                    <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-xs)' }}>
                      {p.damaged ? 'This file cannot be read; forget it.' : `${speechLength(p.seconds)} of speech from ${p.meetings} ${p.meetings === 1 ? 'meeting' : 'meetings'}.`}
                      {p.consent && ` Consent recorded by ${p.consent.recorded_by} on ${new Date(p.consent.at).toLocaleDateString()}${p.old_consent ? ', under an earlier wording' : ''}.`}
                    </span>
                  </span>
                  <Badge variant={tag.warning ? 'warning' : 'accent-subtle'} size="sm">{tag.text}</Badge>
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={`Forget ${p.name}'s voice`} onClick={() => void forget(p.ref, p.name)}>Forget</Button>
                </li>
              );
            })}
          </ul>
        )}
      {data.prints.length > 1 && <div><Button size="sm" variant="danger" disabled={busy} onClick={() => void forgetAll()}>Forget all voices</Button></div>}
      <p style={hintStyle}>
        Kept in <code>~/.gtd/voiceprints</code>, readable only by your account. Backups of this computer (such as Time Machine)
        include that folder, so a forgotten voice may still be in an older backup.
      </p>
    </section>
  );
}
