import { useEffect, useRef, useState } from 'react';
import Button from '@/components/common/Button';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { apiGet } from '@/utils/api';

interface AttachedFile { name: string; size: number; modified: string; type: string; }

interface AttachedFilesProps {
  /** Collection URL, e.g. `/api/outputs/templates/OUT-x/files`. GET lists, POST uploads, `/<name>` opens, DELETE removes. */
  baseUrl: string;
  label: string;
}

const labelStyle: React.CSSProperties = {
  display: 'block', marginBottom: 0, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text)',
};

const iconButton: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, border: 'none',
  background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0, flexShrink: 0,
};

/**
 * Files kept next to a template or a context note: open one in a new tab, download it, attach or remove.
 * Opening uses the browser's own viewer (PDF, HTML, images, text); other types download.
 */
export default function AttachedFiles({ baseUrl, label }: AttachedFilesProps) {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiGet<AttachedFile[]>(baseUrl)
      .then((data) => { setFiles(data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [baseUrl]);

  const fileUrl = (name: string) => `${baseUrl}/${encodeURIComponent(name)}`;

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(baseUrl, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();
      setFiles((prev) => [saved, ...prev.filter((f) => f.name !== saved.name)]);
    } catch (err) { alert(err instanceof Error ? err.message : 'Upload failed'); }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`Remove "${name}"?`)) return;
    try {
      const res = await fetch(fileUrl(name), { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      setFiles((prev) => prev.filter((f) => f.name !== name));
    } catch (err) { alert(err instanceof Error ? err.message : 'Delete failed'); }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <label style={labelStyle}>{label}</label>
        <input ref={inputRef} type="file" style={{ display: 'none' }} onChange={handleUpload} />
        <Button variant="secondary" size="sm" loading={uploading} onClick={() => inputRef.current?.click()}>
          Attach file
        </Button>
      </div>
      {files.length === 0 ? (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: 0 }}>No files attached.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {files.map((f) => (
            <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)' }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
                <path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5Z" stroke="currentColor" strokeWidth="1.2" />
                <path d="M9 1.5V5.5h4" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              <a href={fileUrl(f.name)} target="_blank" rel="noopener noreferrer" title={`Open ${f.name} in a new tab`}
                style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}>
                {f.name}
              </a>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>{(f.size / 1024).toFixed(1)} KB</span>
              <a href={`${fileUrl(f.name)}?download=1`} download={f.name} title="Download" aria-label={`Download ${f.name}`} style={iconButton}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-accent)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}>
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M7 1.5v8M3.5 6.5 7 10l3.5-3.5M2 12.5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
              <button type="button" onClick={() => handleDelete(f.name)} title="Remove" aria-label={`Remove ${f.name}`} style={iconButton}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-critical)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}>
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
