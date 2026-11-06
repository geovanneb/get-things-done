import { languageName } from '@/i18n/serverText';
import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import type React from 'react';
import Notice from '@/components/common/Notice';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Link, useLocation } from 'react-router-dom';
import { useRecorder } from './RecordingProvider';
import Button from '@/components/common/Button';

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function Meter({ label, level }: { label: string; level: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
      <span style={{ width: 70 }}>{label}</span>
      <div aria-hidden style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--color-surface-hover)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(100, Math.sqrt(level) * 100)}%`, background: 'var(--color-success, var(--color-text-muted))' }} />
      </div>
    </div>
  );
}

/**
 * The live transcript heard another language than the one set (or, in Auto, nearly only one language): switch to it,
 * or keep what is set. Switching from a set language applies from where that language started.
 */
function LanguageSuggestion() {
  const { t } = useLanguage();
  const r = useRecorder();
  const s = r.suggestion!;
  const current = r.language === 'auto' ? t('recordingBanner.auto') : r.languages.find((l) => l.id === r.language)?.label ?? r.language;
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 'var(--radius-md)', background: 'var(--color-warning-subtle)', border: '1px solid color-mix(in oklch, var(--color-warning) 40%, transparent)' }}>
      <span style={{ fontSize: 'var(--text-sm)' }}>
        {s.mode === 'auto'
          ? <>{rich(t, 'recordingBanner.mostSpeechSoundsLikeSet', { strong: <strong>{s.label}</strong> })}</>
          : <>{rich(t, 'recordingBanner.thisSoundsLikeButThe', { strong: <strong>{s.label}</strong>, current: current })}</>}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" variant="primary" onClick={() => void r.answerSuggestion('switch', s.id)}>{s.mode === 'auto' ? t('recordingBanner.set', { label: s.label }) : t('recordingBanner.switchTo', { label: s.label })}</Button>
        <Button size="sm" variant="ghost" onClick={() => void r.answerSuggestion('keep', s.id)}>{rich(t, 'recordingBanner.keep', { current: current })}</Button>
      </div>
    </div>
  );
}

/** Shows on every view while a recording runs: what is captured, what is really saved, and how to stop. */
export function RecordingBanner() {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const r = useRecorder();
  const onMeetings = useLocation().pathname === '/meetings';
  if (r.status === 'idle' && !r.notice) return null;
  const line: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: 0 };
  return (
    <div role="region" aria-label={t('queuedMeetingActions.recording')} className="gtd-card" style={{
      position: 'fixed', right: 'var(--space-4)', bottom: 'var(--space-4)', zIndex: 'var(--z-floating)', width: 340, maxWidth: 'calc(100vw - 32px)',
      padding: 'var(--space-3) var(--space-4)', boxShadow: 'var(--shadow-md)', gap: 'var(--space-2)', fontSize: 'var(--text-sm)',
    }}>
      {r.notice && r.status === 'idle' && (
        <>
          <p role="status" style={{ margin: 0 }}>{r.notice}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!onMeetings && r.lastMeetingId && <Link to="/meetings" className="gtd-link">{t('recordingBanner.openTranscript')}</Link>}
            <Button size="sm" variant="ghost" onClick={r.dismiss}>{t('recordingBanner.ok')}</Button>
          </div>
        </>
      )}
      {r.status === 'starting' && <p style={{ margin: 0 }}>{t('recordingBanner.startingTheMicrophone')}</p>}
      {(r.status === 'recording' || r.status === 'saving') && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            <span aria-hidden className={r.status === 'recording' ? 'recording-dot' : undefined} style={{ width: 10, height: 10, borderRadius: 'var(--radius-full)', background: 'var(--color-critical)' }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.status === 'saving' ? t('saving') : t('queuedMeetingActions.recording')} {r.title}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{clock(r.elapsed)}</span>
          </div>
          <Meter label={t('recordMeetingModal.microphone')} level={r.level} />
          {r.systemLevel !== null && <Meter label={t('recordingBanner.computer')} level={r.systemLevel} />}
          <p style={line}>{rich(t, 'recordingBanner.savedOfCaptured', { clock: clock(r.saved), clock2: clock(r.captured), value: r.systemLevel === null ? t('recordingBanner.microphoneOnlyPeopleHeardThrough') : '' })}</p>
          {r.gap > 0 && <p role="status" style={{ ...line, color: 'var(--color-warning)' }}>{rich(t, 'recordingBanner.ofThisMeetingWasNot', { clock: clock(r.gap) })}</p>}
          {r.status === 'recording' && r.languages.length > 0 && (
            <label style={{ ...line, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flexShrink: 0 }}>{t('recordMeetingModal.spokenLanguage')}</span>
              <select aria-label={t('recordMeetingModal.spokenLanguage')} value={r.language} onChange={(e) => void r.setLanguage(e.target.value)}
                className="gtd-control gtd-control--sm" style={{ flex: 1 }}>
                <option value="auto">{t('recordingBanner.auto')}</option>
                {r.languages.filter((l) => l.common).map((l) => <option key={l.id} value={l.id}>{languageName(l.id, l.label)}</option>)}
                {r.languages.some((l) => !l.common) && (
                  <optgroup label={t('recordMeetingModal.otherLanguages')}>
                    {r.languages.filter((l) => !l.common).map((l) => <option key={l.id} value={l.id}>{languageName(l.id, l.label)}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
          )}
          {r.status === 'recording' && r.suggestion && <LanguageSuggestion />}
          {r.languageError && <p role="alert" style={{ ...line, color: 'var(--color-warning)' }}>{r.languageError}</p>}
          {!onMeetings && <Link to="/meetings" className="gtd-link" style={{ fontSize: 'var(--text-xs)' }}>{t('recordingBanner.openMeetingsForTheTranscript')}</Link>}
          {r.lost.map((text) => <p key={text} role="alert" style={{ ...line, color: 'var(--color-warning)' }}>{text}</p>)}
          {r.warning && <p role="alert" style={{ ...line, color: 'var(--color-warning)' }}>{r.warning}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" disabled={r.status === 'saving'} onClick={() => void r.stop()}>{t('recordingBanner.stopAndSave')}</Button>
            <Button size="sm" variant="ghost" disabled={r.status === 'saving'}
              onClick={async () => { if (await confirm({ title: `Discard "${r.title}"?`, message: 'Everything recorded so far is deleted. This cannot be undone.', confirmLabel: 'Discard recording', tone: 'danger' })) void r.discard(); }}>{t('recordingBanner.discard')}</Button>
          </div>
        </>
      )}
      {r.status === 'failed' && (
        <>
          <Notice tone="critical" title={t('recordingBanner.theRecordingStopped')}>{r.error}</Notice>
          <div><Button size="sm" variant="ghost" onClick={r.dismiss}>{t('recordingBanner.ok')}</Button></div>
        </>
      )}
    </div>
  );
}
