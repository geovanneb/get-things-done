import { useState } from 'react';
import Button from '@/components/common/Button';
import Input from '@/components/common/Input';
import Toggle from '@/components/common/Toggle';
import Badge from '@/components/common/Badge';
import { pickFolder } from '@/utils/desktop';
import {
  createRequest,
  initialAnswers,
  toggleTool,
  toolsToInstall,
  type SetupAnswers,
  type SetupStatus,
} from '@/utils/setup';

type Step = 'welcome' | 'folder' | 'profile' | 'ai' | 'done';
type Mode = 'create' | 'open';

const CREATE_STEPS: Step[] = ['folder', 'profile', 'ai'];

const page: React.CSSProperties = {
  // #root is a flex row: take all of it and scroll here when the window is short.
  flex: 1,
  minHeight: '100vh',
  overflowY: 'auto',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  fontFamily: 'var(--font-sans)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px 16px',
  boxSizing: 'border-box',
};

const card: React.CSSProperties = {
  width: '100%',
  maxWidth: 600,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-xl)',
  boxShadow: 'var(--shadow-md)',
  padding: 32,
  boxSizing: 'border-box',
};

const title: React.CSSProperties = { margin: '0 0 8px', fontSize: 'var(--text-xl)', fontWeight: 600 };
const lead: React.CSSProperties = { margin: '0 0 24px', fontSize: 'var(--text-base)', color: 'var(--color-text-secondary)', lineHeight: 1.5 };
const muted: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', lineHeight: 1.5 };
const footer: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 28 };

function Choice({ heading, text, onClick, primary }: { heading: string; text: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        width: '100%',
        padding: '16px 18px',
        borderRadius: 'var(--radius-lg)',
        border: `1px solid ${primary ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: primary ? 'var(--color-accent-subtle)' : 'var(--color-surface)',
        color: 'var(--color-text)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, marginBottom: 4 }}>{heading}</div>
      <div style={muted}>{text}</div>
    </button>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 16,
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-critical-subtle)',
        color: 'var(--color-critical)',
        fontSize: 'var(--text-sm)',
      }}
    >
      {message}
    </div>
  );
}

async function postSetup(body: unknown): Promise<{ status: number; data: { error?: string; needs_init?: boolean; path?: string } }> {
  const res = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** Shown instead of the dashboard until a workspace is open. Works the same in a browser and in the desktop app. */
export default function SetupView({ status }: { status: SetupStatus }) {
  const [step, setStep] = useState<Step>('welcome');
  const [mode, setMode] = useState<Mode>('create');
  const [answers, setAnswers] = useState<SetupAnswers>(() => initialAnswers(status));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notWorkspace, setNotWorkspace] = useState(false);

  const set = (patch: Partial<SetupAnswers>) => setAnswers((current) => ({ ...current, ...patch }));
  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };
  const openDashboard = () => window.location.assign('/situation');

  const browse = async () => {
    setError(null);
    try {
      const picked = await pickFolder();
      if (picked) {
        set({ path: picked });
        setNotWorkspace(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the folder picker. Type the folder path instead.');
    }
  };

  const openExisting = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const { status: code, data } = await postSetup({ path, require_existing: true });
      if (code === 409 && data.needs_init) {
        set({ path: data.path ?? path });
        setNotWorkspace(true);
        return;
      }
      if (code >= 400) {
        setError(data.error ?? `Could not open this folder (HTTP ${code}).`);
        return;
      }
      openDashboard();
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { status: code, data } = await postSetup(createRequest(answers));
      if (code >= 400) {
        setError(data.error ?? `Could not create the workspace (HTTP ${code}).`);
        return;
      }
      go('done');
    } finally {
      setBusy(false);
    }
  };

  const stepNumber = CREATE_STEPS.indexOf(step) + 1;
  const progress = mode === 'create' && stepNumber > 0 ? (
    <div style={{ ...muted, marginBottom: 12 }} aria-live="polite">
      Step {stepNumber} of {CREATE_STEPS.length}
    </div>
  ) : null;

  let content: React.ReactNode;

  if (step === 'welcome') {
    content = (
      <>
        <h1 style={title}>Welcome to Get Things Done</h1>
        <p style={lead}>
          Your tasks, people and notes live in one folder on this computer. AI assistants can work in that folder with you.
          Let&apos;s set it up. It takes about a minute.
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          <Choice
            primary
            heading="Create a new workspace"
            text="Start fresh. You can change everything later."
            onClick={() => {
              setMode('create');
              set({ path: status.suggested_path });
              go('folder');
            }}
          />
          <Choice
            heading="Open an existing workspace"
            text="You already use Get Things Done, or someone shared a workspace folder with you."
            onClick={() => {
              setMode('open');
              set({ path: '' });
              setNotWorkspace(false);
              go('folder');
            }}
          />
        </div>
        {status.recent.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ ...muted, marginBottom: 8 }}>Recently opened on this computer</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {status.recent.map((recent) => (
                <Button key={recent.path} variant="secondary" disabled={busy} onClick={() => void openExisting(recent.path)} style={{ justifyContent: 'flex-start' }}>
                  {recent.name}
                  <span style={{ ...muted, marginLeft: 8, fontFamily: 'var(--font-mono)' }}>{recent.path}</span>
                </Button>
              ))}
            </div>
          </div>
        )}
      </>
    );
  } else if (step === 'folder') {
    const creating = mode === 'create';
    content = (
      <>
        {progress}
        <h1 style={title}>{creating ? 'Where should your workspace live?' : 'Which folder is your workspace?'}</h1>
        <p style={lead}>
          {creating
            ? 'A folder of plain files you own. The suggested place is fine for most people. Pick a synced folder (OneDrive, iCloud, Dropbox) if you want a backup.'
            : 'Choose the folder that contains workspace.yaml.'}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Input
              label="Folder"
              value={answers.path}
              onChange={(value) => {
                set({ path: value });
                setNotWorkspace(false);
              }}
              placeholder={creating ? status.suggested_path : 'Choose a folder'}
              inputStyle={{ fontFamily: 'var(--font-mono)' }}
              autoFocus
            />
          </div>
          <Button variant="secondary" onClick={() => void browse()}>Browse...</Button>
        </div>
        {creating && answers.path.trim() === status.suggested_path && status.suggested_path_is_workspace && (
          <p style={{ ...muted, marginTop: 12 }}>There is already a workspace here. It will be opened as it is.</p>
        )}
        {notWorkspace && (
          <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 'var(--radius-md)', background: 'var(--color-warning-subtle)', fontSize: 'var(--text-sm)' }}>
            This folder is not a Get Things Done workspace yet. You can create one here; files already in the folder are kept.
            <div style={{ marginTop: 10 }}>
              <Button variant="primary" size="sm" onClick={() => { setMode('create'); setNotWorkspace(false); go('profile'); }}>
                Create a workspace in this folder
              </Button>
            </div>
          </div>
        )}
        {error && <ErrorBox message={error} />}
        <div style={footer}>
          <Button variant="ghost" onClick={() => go('welcome')}>Back</Button>
          {creating ? (
            <Button variant="primary" disabled={!answers.path.trim()} onClick={() => go('profile')}>Next</Button>
          ) : (
            <Button variant="primary" disabled={!answers.path.trim() || busy} loading={busy} onClick={() => void openExisting(answers.path.trim())}>
              Open workspace
            </Button>
          )}
        </div>
      </>
    );
  } else if (step === 'profile') {
    content = (
      <>
        {progress}
        <h1 style={title}>About you</h1>
        <p style={lead}>AI assistants use this to write in your name and for your role. Everything is optional and stays in your workspace.</p>
        <div style={{ display: 'grid', gap: 14 }}>
          <Input label="Your name" value={answers.name} onChange={(name) => set({ name })} placeholder="Alex Morgan" autoFocus />
          <Input label="Your role" value={answers.role} onChange={(role) => set({ role })} placeholder="Chief Operating Officer" />
          <Input label="Organization" value={answers.organization} onChange={(organization) => set({ organization })} placeholder="Northwind Labs" />
          <Input
            label="Workspace name"
            value={answers.workspaceName}
            onChange={(workspaceName) => set({ workspaceName })}
            placeholder="Executive Workspace"
            hint="Shown in the sidebar and the window title."
          />
        </div>
        {error && <ErrorBox message={error} />}
        <div style={footer}>
          <Button variant="ghost" onClick={() => go('folder')}>Back</Button>
          <Button variant="primary" onClick={() => go('ai')}>Next</Button>
        </div>
      </>
    );
  } else if (step === 'ai') {
    content = (
      <>
        {progress}
        <h1 style={title}>Which AI assistant do you use?</h1>
        <p style={lead}>
          The workspace gets instructions for the assistants you pick, so they know how to work in it. The dashboard itself
          works without any of them.
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          {status.ai_tools.map((tool) => {
            const on = answers.aiTools.includes(tool.id);
            return (
              <div
                key={tool.id}
                style={{
                  display: 'flex',
                  gap: 14,
                  alignItems: 'flex-start',
                  padding: '14px 16px',
                  borderRadius: 'var(--radius-lg)',
                  border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`,
                }}
              >
                <div style={{ paddingTop: 2 }}>
                  <Toggle checked={on} onChange={(checked) => set({ aiTools: toggleTool(answers.aiTools, tool.id, checked) })} label={tool.label} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                    {tool.label}
                    {tool.installed ? <Badge variant="success">Installed</Badge> : <Badge variant="default">Not found</Badge>}
                  </div>
                  <div style={{ ...muted, marginTop: 4 }}>
                    {tool.description}{' '}
                    {!tool.installed && (
                      <a href={tool.install_url} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent)' }}>
                        How to install
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {error && <ErrorBox message={error} />}
        <div style={footer}>
          <Button variant="ghost" onClick={() => go('profile')}>Back</Button>
          <Button variant="primary" loading={busy} disabled={busy} onClick={() => void create()}>Create workspace</Button>
        </div>
      </>
    );
  } else {
    const pending = toolsToInstall(answers, status.ai_tools);
    content = (
      <>
        <h1 style={title}>Your workspace is ready</h1>
        <p style={lead}>
          It lives in <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>{answers.path}</span>.
          Start by adding a task or a stakeholder.
        </p>
        {pending.length > 0 && (
          <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-md)', background: 'var(--color-info-subtle)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
            To let AI work on your tasks, install{' '}
            {pending.map((tool, i) => (
              <span key={tool.id}>
                {i > 0 && (i === pending.length - 1 ? ' or ' : ', ')}
                <a href={tool.install_url} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent)' }}>{tool.label}</a>
              </span>
            ))}
            . You can do it any time; the workspace is already prepared for it.
          </div>
        )}
        <div style={{ ...footer, justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={openDashboard}>Open the dashboard</Button>
        </div>
      </>
    );
  }

  return (
    <main style={page}>
      <div style={card}>{content}</div>
    </main>
  );
}
