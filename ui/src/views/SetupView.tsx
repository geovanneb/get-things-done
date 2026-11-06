import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import { useState } from 'react';
import Notice from '@/components/common/Notice';
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
    <button type="button" onClick={onClick} className={`gtd-choice${primary ? ' gtd-choice--primary' : ''}`}>
      <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, marginBottom: 4 }}>{heading}</div>
      <div style={muted}>{text}</div>
    </button>
  );
}

function ErrorBox({ message }: { message: string }) {
  return <Notice tone="critical" style={{ marginTop: 'var(--space-4)' }}>{message}</Notice>;
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
  const { t } = useLanguage();
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
      setError(err instanceof Error ? err.message : t('setup.couldNotOpenTheFolder'));
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
        setError(data.error ?? t('setup.couldNotOpenThisFolder', { code }));
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
        setError(data.error ?? t('setup.couldNotCreateTheWorkspace', { code }));
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
      {rich(t, 'setup.stepOf', { stepNumber: stepNumber, length: CREATE_STEPS.length })}
    </div>
  ) : null;

  let content: React.ReactNode;

  if (step === 'welcome') {
    content = (
      <>
        <h1 style={title}>{t('setup.welcomeToGetThingsDone')}</h1>
        <p style={lead}>
          {t('setup.yourTasksPeopleAndNotes')}
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          <Choice
            primary
            heading={t('setup.createANewWorkspace')}
            text={t('setup.startFreshYouCanChange')}
            onClick={() => {
              setMode('create');
              set({ path: status.suggested_path });
              go('folder');
            }}
          />
          <Choice
            heading={t('setup.openAnExistingWorkspace')}
            text={t('setup.youAlreadyUseGetThings')}
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
            <div style={{ ...muted, marginBottom: 8 }}>{t('setup.recentlyOpenedOnThisComputer')}</div>
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
        <h1 style={title}>{creating ? t('setup.whereShouldYourWorkspaceLive') : t('setup.whichFolderIsYourWorkspace')}</h1>
        <p style={lead}>
          {creating
            ? t('setup.aFolderOfPlainFiles')
            : t('setup.chooseTheFolderThatContains')}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Input
              label={t('setup.folder')}
              value={answers.path}
              onChange={(value) => {
                set({ path: value });
                setNotWorkspace(false);
              }}
              placeholder={creating ? status.suggested_path : t('setup.chooseAFolder')}
              inputStyle={{ fontFamily: 'var(--font-mono)' }}
              autoFocus
            />
          </div>
          <Button variant="secondary" onClick={() => void browse()}>{t('setup.browse')}</Button>
        </div>
        {creating && answers.path.trim() === status.suggested_path && status.suggested_path_is_workspace && (
          <p style={{ ...muted, marginTop: 12 }}>{t('setup.thereIsAlreadyAWorkspace')}</p>
        )}
        {notWorkspace && (
          <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 'var(--radius-md)', background: 'var(--color-warning-subtle)', fontSize: 'var(--text-sm)' }}>
            {t('setup.thisFolderIsNotA')}
            <div style={{ marginTop: 10 }}>
              <Button variant="primary" size="sm" onClick={() => { setMode('create'); setNotWorkspace(false); go('profile'); }}>
                {t('setup.createAWorkspaceInThis')}
              </Button>
            </div>
          </div>
        )}
        {error && <ErrorBox message={error} />}
        <div style={footer}>
          <Button variant="ghost" onClick={() => go('welcome')}>{t('setup.back')}</Button>
          {creating ? (
            <Button variant="primary" disabled={!answers.path.trim()} onClick={() => go('profile')}>{t('setup.next')}</Button>
          ) : (
            <Button variant="primary" disabled={!answers.path.trim() || busy} loading={busy} onClick={() => void openExisting(answers.path.trim())}>
              {t('setup.openWorkspace')}
            </Button>
          )}
        </div>
      </>
    );
  } else if (step === 'profile') {
    content = (
      <>
        {progress}
        <h1 style={title}>{t('setup.aboutYou')}</h1>
        <p style={lead}>{t('setup.aiAssistantsUseThisTo')}</p>
        <div style={{ display: 'grid', gap: 14 }}>
          <Input label={t('profile.yourName')} value={answers.name} onChange={(name) => set({ name })} placeholder="Alex Morgan" autoFocus />
          <Input label={t('setup.yourRole')} value={answers.role} onChange={(role) => set({ role })} placeholder={t('setup.chiefOperatingOfficer')} />
          <Input label={t('orgChartDialogs.organization')} value={answers.organization} onChange={(organization) => set({ organization })} placeholder="Northwind Labs" />
          <Input
            label={t('workspaceName')}
            value={answers.workspaceName}
            onChange={(workspaceName) => set({ workspaceName })}
            placeholder={t('setup.executiveWorkspace')}
            hint={t('setup.shownInTheSidebarAnd')}
          />
        </div>
        {error && <ErrorBox message={error} />}
        <div style={footer}>
          <Button variant="ghost" onClick={() => go('folder')}>{t('setup.back')}</Button>
          <Button variant="primary" onClick={() => go('ai')}>{t('setup.next')}</Button>
        </div>
      </>
    );
  } else if (step === 'ai') {
    content = (
      <>
        {progress}
        <h1 style={title}>{t('setup.whichAiAssistantDoYou')}</h1>
        <p style={lead}>
          {t('setup.theWorkspaceGetsInstructionsFor')}
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
                    {tool.installed ? <Badge variant="success">{t('agents.installed')}</Badge> : <Badge variant="default">{t('setup.notFound')}</Badge>}
                  </div>
                  <div style={{ ...muted, marginTop: 4 }}>
                    {tool.description}{' '}
                    {!tool.installed && (
                      <a href={tool.install_url} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent)' }}>
                        {t('setup.howToInstall')}
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
          <Button variant="ghost" onClick={() => go('profile')}>{t('setup.back')}</Button>
          <Button variant="primary" loading={busy} disabled={busy} onClick={() => void create()}>{t('setup.createWorkspace')}</Button>
        </div>
      </>
    );
  } else {
    const pending = toolsToInstall(answers, status.ai_tools);
    content = (
      <>
        <h1 style={title}>{t('setup.yourWorkspaceIsReady')}</h1>
        <p style={lead}>
          {rich(t, 'setup.itLivesInStartBy', { part: <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>{answers.path}</span> })}
        </p>
        {pending.length > 0 && (
          <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-md)', background: 'var(--color-info-subtle)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
            {t('setup.toLetAiWorkOn')}{' '}
            {pending.map((tool, i) => (
              <span key={tool.id}>
                {i > 0 && (i === pending.length - 1 ? ' or ' : ', ')}
                <a href={tool.install_url} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent)' }}>{tool.label}</a>
              </span>
            ))}
            {t('setup.youCanDoItAny')}
          </div>
        )}
        <div style={{ ...footer, justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={openDashboard}>{t('setup.openTheDashboard')}</Button>
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
