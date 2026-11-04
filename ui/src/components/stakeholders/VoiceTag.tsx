import React from 'react';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import { apiDelete } from '@/utils/api';
import { voiceTag } from '@/utils/voiceprints';
import type { RememberedVoice, Voiceprints } from '@/types';

/** The voices remembered on this computer, by stakeholder id; refreshed when they change. */
export function useRememberedVoices(): { voices: Map<string, RememberedVoice>; refetch: () => void } {
  const version = useDataVersion('voiceprints');
  const { data, refetch } = useApi<Voiceprints>('/api/voiceprints', [version]);
  const voices = React.useMemo(() => new Map((data?.prints ?? []).map((p) => [p.ref, p] as const)), [data]);
  return { voices, refetch };
}

/** The tag a stakeholder with a remembered voice gets. */
export function VoiceBadge({ voice }: { voice: RememberedVoice | undefined }) {
  if (!voice) return null;
  const tag = voiceTag(voice);
  return <Badge variant={tag.warning ? 'warning' : 'accent-subtle'} size="sm">{tag.text}</Badge>;
}

/** On a stakeholder's page: the tag, and Forget this voice. */
export function StakeholderVoice({ id, name }: { id: string; name: string }) {
  const confirm = useConfirm();
  const { voices, refetch } = useRememberedVoices();
  const [error, setError] = React.useState<string | null>(null);
  const voice = voices.get(id);
  if (!voice) return null;
  const forget = async () => {
    if (!(await confirm({ title: `Forget ${name}'s voice?`, message: 'The app stops suggesting this name. Names already given in transcripts stay. Copies in backups of this computer are not removed.', confirmLabel: 'Forget voice', tone: 'danger' }))) return;
    setError(null);
    try { await apiDelete(`/api/voiceprints/${encodeURIComponent(id)}`); refetch(); } catch (err) { setError((err as Error).message); }
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
      <VoiceBadge voice={voice} />
      <Button size="sm" variant="ghost" onClick={() => void forget()}>Forget this voice</Button>
      {error && <span role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)' }}>{error}</span>}
    </span>
  );
}
