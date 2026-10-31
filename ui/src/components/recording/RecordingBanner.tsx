import type React from 'react';
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

/** Shows on every view while a recording runs: what is captured, what is really saved, and how to stop. */
export function RecordingBanner() {
  const r = useRecorder();
  const onMeetings = useLocation().pathname === '/meetings';
  if (r.status === 'idle' && !r.notice) return null;
  const line: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: 0 };
  return (
    <div role="region" aria-label="Recording" style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 900, width: 320, maxWidth: 'calc(100vw - 32px)', padding: 12,
      background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 4px 16px rgba(0,0,0,.2)',
      display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)',
    }}>
      {r.notice && r.status === 'idle' && (
        <>
          <p role="status" style={{ margin: 0 }}>{r.notice}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!onMeetings && r.lastMeetingId && <Link to="/meetings" style={{ color: 'var(--color-accent)' }}>Open transcript</Link>}
            <Button size="sm" variant="ghost" onClick={r.dismiss}>OK</Button>
          </div>
        </>
      )}
      {r.status === 'starting' && <p style={{ margin: 0 }}>Starting the microphone…</p>}
      {(r.status === 'recording' || r.status === 'saving') && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-critical)' }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.status === 'saving' ? 'Saving…' : 'Recording'} {r.title}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{clock(r.elapsed)}</span>
          </div>
          <Meter label="Microphone" level={r.level} />
          {r.systemLevel !== null && <Meter label="Computer" level={r.systemLevel} />}
          <p style={line}>Saved {clock(r.saved)} of {clock(r.captured)} captured.{r.systemLevel === null ? ' Microphone only: people heard through headphones are not recorded.' : ''}</p>
          {r.gap > 0 && <p role="status" style={{ ...line, color: 'var(--color-warning)' }}>{clock(r.gap)} of this meeting was not captured, for example while the computer slept.</p>}
          {r.status === 'recording' && r.languages.length > 0 && (
            <label style={{ ...line, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flexShrink: 0 }}>Spoken language</span>
              <select aria-label="Spoken language" value={r.language} onChange={(e) => void r.setLanguage(e.target.value)}
                style={{ flex: 1, minWidth: 0, padding: '2px 4px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}>
                <option value="auto">Auto</option>
                {r.languages.filter((l) => l.common).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                {r.languages.some((l) => !l.common) && (
                  <optgroup label="Other languages">
                    {r.languages.filter((l) => !l.common).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
          )}
          {r.languageError && <p role="alert" style={{ ...line, color: 'var(--color-warning)' }}>{r.languageError}</p>}
          <Link to="/meetings" style={{ ...line, color: 'var(--color-accent)' }}>Open Meetings for the transcript</Link>
          {r.lost.map((text) => <p key={text} role="alert" style={{ ...line, color: 'var(--color-warning)' }}>{text}</p>)}
          {r.warning && <p role="alert" style={{ ...line, color: 'var(--color-warning)' }}>{r.warning}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" disabled={r.status === 'saving'} onClick={() => void r.stop()}>Stop and save</Button>
            <Button size="sm" variant="ghost" disabled={r.status === 'saving'}
              onClick={() => { if (window.confirm(`Discard "${r.title}"? Everything recorded so far is deleted.`)) void r.discard(); }}>Discard</Button>
          </div>
        </>
      )}
      {r.status === 'failed' && (
        <>
          <p role="alert" style={{ margin: 0, color: 'var(--color-critical)' }}>{r.error}</p>
          <div><Button size="sm" variant="ghost" onClick={r.dismiss}>OK</Button></div>
        </>
      )}
    </div>
  );
}
