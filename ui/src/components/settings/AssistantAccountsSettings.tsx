import { useLanguage } from '@/i18n/LanguageProvider';
import { serverText } from '@/i18n/serverText';
import React from 'react';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Input from '@/components/common/Input';
import Notice from '@/components/common/Notice';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api';
import { accountActions, accountLine, accountSubline, defaultMethod, offeredMethods, showChoice, signInResult } from '@/utils/assistantAccounts';
import type { AssistantAccount, AssistantAccounts, AssistantAccountsView, AssistantSignIn, AssistantSignInMethod } from '@/types';

const small: React.CSSProperties = { margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', maxWidth: 640 };
const note: React.CSSProperties = { margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', maxWidth: 640 };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all', userSelect: 'all' };
const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' };

type Act = (key: string, action: () => Promise<AssistantAccounts | void>) => Promise<void>;
/** A sign-in about to start: the account, and the method picked. Nothing runs until the user says so. */
interface Pending { folder: string | null; method: AssistantSignInMethod | null }

/**
 * Settings → Assistant accounts (#505): which account Claude Code, Codex and GitHub Copilot use when the dashboard
 * starts them, and signing in or out with each tool's own sign-in. Plain words first: accounts are named by who is
 * signed in; folders, commands and the tool's own messages stay under Details.
 */
export default function AssistantAccountsSettings() {
  const { t } = useLanguage();
  const [data, setData] = React.useState<AssistantAccounts | null | undefined>(undefined);
  const [signIn, setSignIn] = React.useState<AssistantSignIn | null>(null);
  // The result of a sign-in is shown only for one started on this page, until the next action.
  const [resultFor, setResultFor] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const next = await apiGet<AssistantAccounts>('/api/assistant-accounts');
      setData(next);
      setSignIn(next.sign_in);
    } catch { setData(null); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  // While a sign-in waits for the browser, check it every two seconds; once it ends, read the accounts again.
  const going = signIn?.status === 'running';
  React.useEffect(() => {
    if (!going) return;
    let live = true;
    const timer = setInterval(() => {
      apiGet<{ sign_in: AssistantSignIn | null }>('/api/assistant-accounts/sign-in').then((r) => {
        if (!live) return;
        setSignIn(r.sign_in);
        if (r.sign_in?.status !== 'running') void load();
      }, () => {});
    }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [going, load]);

  const act: Act = async (key, action) => {
    setBusy(key);
    setError(null);
    setResultFor(null);
    try {
      const next = await action();
      if (next) { setData(next); setSignIn(next.sign_in); }
    } catch (err) {
      setError(err instanceof Error && err.message ? serverText(err.message) : t('assistantAccounts.loadError'));
    } finally { setBusy(null); }
  };
  const start = (id: string, folder: string | null, method: AssistantSignInMethod | null) => act(`in:${id}`, async () => {
    const r = await apiPost<{ sign_in: AssistantSignIn }>(`/api/assistant-accounts/${id}/sign-in`, { folder, method });
    setSignIn(r.sign_in);
    setResultFor(r.sign_in.started_at);
  });
  const cancel = () => act('cancel', async () => {
    await apiDelete('/api/assistant-accounts/sign-in');
    const r = await apiGet<{ sign_in: AssistantSignIn | null }>('/api/assistant-accounts/sign-in');
    setSignIn(r.sign_in);
    setResultFor(r.sign_in?.started_at ?? null);
  });

  if (data === undefined) return <p style={note}>{t('loading')}</p>;
  if (data === null) return <Notice tone="warning" action={<Button size="sm" onClick={() => void load()}>{t('retry')}</Button>}>{t('assistantAccounts.loadError')}</Notice>;
  const installed = data.assistants.filter((a) => a.installed);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <p style={small}>{t('assistantAccounts.intro')}</p>
      {error && <Notice tone="critical">{error}</Notice>}
      {installed.length === 0 && <Notice tone="info">{t('assistantAccounts.noneInstalled')}</Notice>}
      {installed.map((view) => (
        <AssistantSection key={view.id} view={view} signIn={signIn?.assistant === view.id ? signIn : null} otherSignInGoing={going && signIn?.assistant !== view.id}
          showResult={signIn?.assistant === view.id && signIn.started_at === resultFor} busy={busy} act={act} start={start} cancel={cancel} />
      ))}
    </div>
  );
}

function AssistantSection({ view, signIn, otherSignInGoing, showResult, busy, act, start, cancel }: {
  view: AssistantAccountsView;
  signIn: AssistantSignIn | null;
  otherSignInGoing: boolean;
  showResult: boolean;
  busy: string | null;
  act: Act;
  start: (id: string, folder: string | null, method: AssistantSignInMethod | null) => Promise<void>;
  cancel: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [adding, setAdding] = React.useState<string | null>(null);
  const [details, setDetails] = React.useState(false);
  const [path, setPath] = React.useState('');
  const going = signIn?.status === 'running' || otherSignInGoing;
  const result = showResult && signIn ? signInResult(signIn) : null;
  const many = showChoice(view);
  const label = view.label;

  const prepare = (a: AssistantAccount) => { setAdding(null); setPending({ folder: a.folder, method: defaultMethod(view, a) }); };
  const signOut = async (a: AssistantAccount) => {
    if (!(await confirm({ title: t('assistantAccounts.confirmSignOutTitle', { assistant: label }), message: t('assistantAccounts.confirmSignOutBody'), confirmLabel: t('assistantAccounts.signOut'), tone: 'danger' }))) return;
    await act(`out:${view.id}`, () => apiPost<AssistantAccounts>(`/api/assistant-accounts/${view.id}/sign-out`, { folder: a.folder, confirm: true }));
  };
  const addAccount = () => act(`new:${view.id}`, async () => {
    const made = await apiPost<{ folder: string; view: AssistantAccounts }>(`/api/assistant-accounts/${view.id}/accounts`, { name: adding?.trim() || null });
    setAdding(null);
    setPending({ folder: made.folder, method: defaultMethod(view, null) });
    return made.view;
  });

  const accountRow = (a: AssistantAccount) => {
    const can = accountActions(view, a, going);
    const sub = accountSubline(a);
    return (
      <li key={a.folder ?? ''} style={{ ...row, padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: a.chosen && many ? 'var(--color-surface-hover)' : undefined }}>
        <span style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={row}>
            <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', wordBreak: 'break-word' }}>{accountLine(a)}</span>
            {a.chosen && many && <Badge variant="accent">{t('assistantAccounts.inUse')}</Badge>}
          </span>
          {sub && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{sub}</span>}
          {a.signed_in && a.plan_ok === false && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-warning)' }}>{t('assistantAccounts.notPlan')}</span>}
        </span>
        <span style={row}>
          {many && can.use && <Button size="sm" variant="primary" loading={busy === `use:${view.id}:${a.folder}`} disabled={busy !== null} onClick={() => void act(`use:${view.id}:${a.folder}`, () => apiPut<AssistantAccounts>(`/api/assistant-accounts/${view.id}/choice`, { folder: a.folder }))}>{t('assistantAccounts.useThis')}</Button>}
          {can.signIn && <Button size="sm" disabled={busy !== null} onClick={() => prepare(a)}>{a.signed_in ? t('assistantAccounts.signInAgain') : t('assistantAccounts.signIn')}</Button>}
          {can.signOut && <Button size="sm" variant="ghost" loading={busy === `out:${view.id}`} disabled={busy !== null} onClick={() => void signOut(a)}>{t('assistantAccounts.signOut')}</Button>}
          {many && can.remove && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(`rm:${view.id}`, async () => { await apiDelete(`/api/assistant-accounts/${view.id}/folders?path=${encodeURIComponent(a.folder ?? '')}`); return apiGet<AssistantAccounts>('/api/assistant-accounts'); })}>{t('assistantAccounts.removeFromList')}</Button>}
        </span>
      </li>
    );
  };

  const pendingAccount = pending ? view.accounts.find((a) => a.folder === pending.folder) ?? null : null;
  const methods = offeredMethods(view, pendingAccount, details);
  const methodLabel = (m: AssistantSignInMethod) => (m === 'sso' ? t('assistantAccounts.methodSso') : m === 'console' ? t('assistantAccounts.methodConsole') : t('assistantAccounts.methodAccount'));
  const signInAccount = signIn ? view.accounts.find((a) => a.folder === signIn.folder) ?? null : null;

  return (
    <section aria-label={t('assistantAccounts.question', { assistant: label })} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <h3 style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 600 }}>{t('assistantAccounts.question', { assistant: label })}</h3>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {view.accounts.map(accountRow)}
      </ul>
      {view.id === 'copilot' && <p style={small}>{t('assistantAccounts.copilotOnly')}</p>}

      {pending && !going && (
        <Notice tone="info">
          <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <span>{t('assistantAccounts.before', { assistant: label })}</span>
            {methods.length > 1 && (
              <span role="radiogroup" aria-label={t('assistantAccounts.signIn')} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {methods.map((m) => (
                  <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
                    <input type="radio" name={`method-${view.id}`} checked={pending.method === m} onChange={() => setPending({ ...pending, method: m })} />
                    {methodLabel(m)}
                  </label>
                ))}
              </span>
            )}
            {view.sso === 'on_page' && <span style={note}>{t('assistantAccounts.ssoOnPage')}</span>}
            <span style={row}>
              <Button size="sm" variant="primary" loading={busy === `in:${view.id}`} disabled={busy !== null} onClick={() => { const p = pending; setPending(null); void start(view.id, p.folder, p.method); }}>{t('assistantAccounts.openBrowser')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>{t('cancel')}</Button>
            </span>
          </span>
        </Notice>
      )}

      {signIn?.status === 'running' && (
        <Notice tone="info" action={<Button size="sm" loading={busy === 'cancel'} onClick={() => void cancel()}>{t('cancel')}</Button>}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <span>{t('assistantAccounts.waiting', { assistant: label })}</span>
            {signIn.url && <a href={signIn.url} target="_blank" rel="noopener noreferrer">{t('assistantAccounts.browserDidNotOpen')}</a>}
          </span>
        </Notice>
      )}
      {result && (
        <Notice tone={result.tone} action={result.tone === 'critical' && signIn ? <Button size="sm" onClick={() => setPending({ folder: signIn.folder, method: signIn.method })}>{t('assistantAccounts.tryAgain')}</Button> : undefined}>
          {result.text}
        </Notice>
      )}

      {view.choosable && adding === null && !pending && (
        <span><Button size="sm" variant="ghost" disabled={going || busy !== null} onClick={() => { setPending(null); setAdding(''); }}>{t('assistantAccounts.useAnother')}</Button></span>
      )}
      {adding !== null && (
        <div style={{ ...row, alignItems: 'flex-end' }}>
          <Input label={t('assistantAccounts.newName')} value={adding} onChange={setAdding} maxLength={40} style={{ flex: '1 1 220px', maxWidth: 320 }} hint={t('assistantAccounts.newNameHint')} />
          <span style={{ ...row, paddingBottom: 'var(--space-5)' }}>
            <Button size="sm" variant="primary" loading={busy === `new:${view.id}`} disabled={busy !== null} onClick={() => void addAccount()}>{t('assistantAccounts.continue')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>{t('cancel')}</Button>
          </span>
        </div>
      )}

      <details open={details} onToggle={(e) => setDetails((e.target as HTMLDetailsElement).open)} style={{ fontSize: 'var(--text-sm)' }}>
        <summary style={{ cursor: 'pointer', color: 'var(--color-text-secondary)' }}>{t('assistantAccounts.details')}</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          <ul style={{ ...note, paddingLeft: 'var(--space-4)' }}>
            {view.accounts.map((a) => <li key={a.folder ?? ''}>{t('assistantAccounts.folderOf', { account: a.folder === null ? t('assistantAccounts.defaultAccount') : (a.name ?? accountLine(a)), folder: a.path_label })}</li>)}
          </ul>
          <span style={note}>{t('assistantAccounts.terminalHint')}</span>
          <code style={mono}>{(signInAccount ?? view.accounts.find((a) => a.chosen) ?? view.accounts[0])?.terminal_command}</code>
          {view.choosable && (
            <div style={{ ...row, alignItems: 'flex-end' }}>
              <Input label={t('assistantAccounts.addFolder')} value={path} onChange={setPath} style={{ flex: '1 1 320px', maxWidth: 520 }} hint={t('assistantAccounts.addFolderHint')} />
              <span style={{ paddingBottom: 'var(--space-5)' }}>
                <Button size="sm" disabled={!path.trim() || busy !== null} loading={busy === `add:${view.id}`}
                  onClick={() => void act(`add:${view.id}`, async () => { const next = await apiPost<AssistantAccounts>(`/api/assistant-accounts/${view.id}/folders`, { path: path.trim() }); setPath(''); return next; })}>{t('assistantAccounts.add')}</Button>
              </span>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
