import { useEffect, useMemo, useRef, useState } from 'react';
import Button from '@/components/common/Button';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { apiGet } from '@/utils/api';
import { groupByFolder } from '@/utils/attachedFiles';

interface AttachedFile { name: string; size: number; modified: string; type: string; removable?: boolean; }

interface AttachedFilesProps {
  /** Collection URL, e.g. `/api/outputs/templates/OUT-x/files`. GET lists, POST uploads, `/<name>` opens, DELETE removes. */
  baseUrl: string;
  label: string;
  /** URL of a ZIP with the whole folder; shows a "Download all" link. */
  archiveUrl?: string;
}

const labelStyle: React.CSSProperties = {
  display: 'block', marginBottom: 0, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text)',
};

/** The server's error message (`{ message }`) for a failed request, or `fallback`. */
async function responseError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null) as { message?: string } | null;
  return new Error(body?.message ?? `${fallback} (${res.status})`);
}

const iconButton: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, border: 'none',
  background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0, flexShrink: 0,
};

/**
 * Files kept next to a template or a context note: open one in a new tab, download it, attach or remove.
 * Opening uses the browser's own viewer (PDF, HTML, images, text); other types download.
 * Subfolders (e.g. assets/, source/) are listed read-only: attach and remove act on the top level only.
 * Each subfolder starts collapsed, showing its name and file count; clicking it shows its files.
 */
export default function AttachedFiles({ baseUrl, label, archiveUrl }: AttachedFilesProps) {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  useEffect(() => {
    apiGet<AttachedFile[]>(baseUrl)
      .then((data) => { setFiles(data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [baseUrl]);

  // Another template or note: its folders start collapsed again.
  useEffect(() => { setOpenFolders(new Set()); }, [baseUrl]);

  const toggleFolder = (folder: string) => setOpenFolders((prev) => {
    const next = new Set(prev);
    if (next.has(folder)) next.delete(folder); else next.add(folder);
    return next;
  });

  // Names can include subfolders ("assets/logo.png"); encode each part, keep the slashes.
  const fileUrl = (name: string) => `${baseUrl}/${name.split('/').map(encodeURIComponent).join('/')}`;

  // Top-level files first (they can be removed here), then one group per subfolder (read-only here).
  const groups = useMemo(() => groupByFolder(files), [files]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(baseUrl, { method: 'POST', body: form });
      if (!res.ok) throw await responseError(res, 'Upload failed');
      const saved = await res.json();
      setFiles((prev) => [saved, ...prev.filter((f) => f.name !== saved.name)]);
    } catch (err) { alert(err instanceof Error ? err.message : 'Upload failed'); }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`Remove "${name}"?`)) return;
    try {
      const res = await fetch(fileUrl(name), { method: 'DELETE' });
      if (!res.ok) throw await responseError(res, 'Remove failed');
      setFiles((prev) => prev.filter((f) => f.name !== name));
    } catch (err) { alert(err instanceof Error ? err.message : 'Delete failed'); }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <label style={labelStyle}>{label}</label>
        <input ref={inputRef} type="file" style={{ display: 'none' }} onChange={handleUpload} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {archiveUrl && files.length > 0 && (
            <a href={archiveUrl} download title="Download everything in this folder as one .zip"
              onClick={(e) => { e.preventDefault(); void downloadArchive(archiveUrl); }}
              style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent)', textDecoration: 'none', whiteSpace: 'nowrap' }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}>
              Download all (.zip)
            </a>
          )}
          <Button variant="secondary" size="sm" loading={uploading} onClick={() => inputRef.current?.click()}>
            Attach file
          </Button>
        </div>
      </div>
      {files.length === 0 ? (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: 0 }}>No files attached.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {groups.map((g) => {
            const open = !g.folder || openFolders.has(g.folder);
            return (
              <div key={g.folder || '.'} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {g.folder && (
                  <button type="button" onClick={() => toggleFolder(g.folder)} aria-expanded={open}
                    title={`${open ? 'Hide' : 'Show'} the ${g.items.length} file${g.items.length === 1 ? '' : 's'} directly in ${g.folder}/. Files in subfolders can be opened and downloaded here; change them in the workspace folder`}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%', marginTop: 4, padding: '2px 0', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"
                      style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: reduceMotion ? undefined : 'transform 120ms ease' }}>
                      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                      <path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-10.9a1 1 0 0 1-1-1V4.5Z" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{g.folder}/ · {g.items.length}</span>
                  </button>
                )}
                {open && g.items.map((f) => (
                  <FileRow key={f.name} file={f} url={fileUrl(f.name)}
                    label={g.folder ? f.name.slice(g.folder.length + 1) : f.name}
                    onRemove={g.folder || f.removable === false ? undefined : () => handleDelete(f.name)}
                    note={!g.folder && f.removable === false ? 'This name can only be changed or removed in the workspace folder' : undefined} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One file: name opens it in a new tab, then size, download and (top-level files only) remove. */
function FileRow({ file, url, label, onRemove, note }: { file: AttachedFile; url: string; label: string; onRemove?: () => void; note?: string }) {
  return (
    <div title={note} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', marginLeft: file.name.includes('/') ? 18 : 0, background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)' }}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
        <path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5Z" stroke="currentColor" strokeWidth="1.2" />
        <path d="M9 1.5V5.5h4" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <a href={url} target="_blank" rel="noopener noreferrer" title={`Open ${file.name} in a new tab`}
        style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
        onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}>
        {label}
      </a>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>{(file.size / 1024).toFixed(1)} KB</span>
      <a href={`${url}?download=1`} download={label} title="Download" aria-label={`Download ${file.name}`} style={iconButton}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-accent)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}>
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 1.5v8M3.5 6.5 7 10l3.5-3.5M2 12.5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
      {onRemove ? (
        <button type="button" onClick={onRemove} title="Remove" aria-label={`Remove ${file.name}`} style={iconButton}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-critical)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      ) : <span style={{ width: 20, flexShrink: 0 }} />}
    </div>
  );
}

/**
 * Fetches the folder's ZIP and saves it. When the server refuses (too many files, a name a ZIP cannot hold),
 * its message is shown instead of a failed or half-empty download.
 */
async function downloadArchive(url: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { message?: string } | null;
      throw new Error(body?.message?.replace(/^Invalid: /, '') ?? `Download failed (${res.status})`);
    }
    const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'files.zip';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await res.blob());
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Download failed');
  }
}
