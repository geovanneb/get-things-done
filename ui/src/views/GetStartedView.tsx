import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import { serverText } from '@/i18n/serverText';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Notice from '@/components/common/Notice';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import IconButton, { icons } from '@/components/common/IconButton';
import Input, { Select, Textarea } from '@/components/common/Input';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import DictateButton from '@/components/common/DictateButton';
import { DropZone, uploadMaterial } from '@/components/context-updates/ImportUpdateModal';
import { formatBytes, hardToRead } from '@/components/context-updates/shared';
import { useAssistant } from '@/hooks/useAssistant';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api';
import { dictationModels, withDictation } from '@/utils/dictation';
import type { ContextUpdate, RunnerStatus, Transcription } from '@/types';
import {
  COUNTED_STEPS, ORGANIZATION_RELATIONSHIPS, PERSON_RELATIONSHIPS, canSend, emptyOrganization, emptyPerson, nextStep,
  ownFiles, previousStep, stepAnswered, stepNumber, unnamedRows, withoutEmptyRows,
  type FirstContextAnswers, type FirstContextState, type Step,
} from '@/utils/firstContext';

const SAVE_DELAY_MS = 800;

const page: React.CSSProperties = {
  // #root is a flex row: take all of it and scroll here when the window is short.
  flex: 1,
  minHeight: '100vh',
  overflowY: 'auto',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  fontFamily: 'var(--font-sans)',
  display: 'flex',
  justifyContent: 'center',
  padding: '32px 16px',
  boxSizing: 'border-box',
};

const card: React.CSSProperties = {
  // Centred when it fits, from the top (and scrolling) when it does not.
  margin: 'auto 0',
  width: '100%',
  maxWidth: 720,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-xl)',
  boxShadow: 'var(--shadow-md)',
  padding: 'clamp(20px, 4vw, 32px)',
  boxSizing: 'border-box',
};

const title: React.CSSProperties = { margin: '0 0 8px', fontSize: 'var(--text-xl)', fontWeight: 600, outlineOffset: 4 };
const lead: React.CSSProperties = { margin: '0 0 24px', fontSize: 'var(--text-base)', color: 'var(--color-text-secondary)', lineHeight: 1.5 };
const muted: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', lineHeight: 1.5 };
const stack: React.CSSProperties = { display: 'grid', gap: 18 };
const row: React.CSSProperties = { border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px', display: 'grid', gap: 10 };
const rowGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 };
const list: React.CSSProperties = { margin: '6px 0 0', paddingLeft: 20, display: 'grid', gap: 4 };

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Get started: a short interview and the executive's own files, sent to their assistant as the first context update
 * (`kind: first-context`). It comes after the first-run setup, outside the app shell so the executive sees one thing
 * at a time. Every step can be skipped, the answers are saved as they type, and "Finish later" is always there.
 */
export default function GetStartedView() {
  const { t } = useLanguage();
  const assistant = useAssistant();
  const navigate = useNavigate();
  const [state, setState] = useState<FirstContextState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [answers, setAnswers] = useState<FirstContextAnswers | null>(null);
  const [step, setStep] = useState<Step>('intro');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  // Saves go out one after another, so an older draft never lands after a newer one.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef<FirstContextAnswers | null>(null);

  const load = useCallback(() => {
    setLoadError(false);
    apiGet<FirstContextState>('/api/first-context')
      .then((loaded) => {
        setState(loaded);
        setAnswers(loaded.answers);
        latest.current = loaded.answers;
        // Coming back to a draft: the review shows what is there and leads to any step in one click.
        if (loaded.status === 'in_progress' && canSend(loaded.answers, ownFiles(loaded.update).length)) setStep('review');
      })
      .catch(() => setLoadError(true));
  }, []);
  useEffect(load, [load]);

  const save = useCallback((value: FirstContextAnswers) => {
    setSaveState('saving');
    const run = saving.current.then(() => apiPut<FirstContextState>('/api/first-context', { answers: value }))
      .then(() => { setSaveState('saved'); })
      .catch(() => { dirty.current = true; setSaveState('failed'); });
    saving.current = run;
    return run;
  }, []);

  useEffect(() => {
    if (!answers || !dirty.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { dirty.current = false; void save(answers); }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer.current);
  }, [answers, save]);

  /** Saves what is typed now, before leaving the step or the screen. False when the save failed. */
  const flush = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    if (dirty.current && latest.current) {
      dirty.current = false;
      await save(latest.current);
    }
    await saving.current;
    return !dirty.current;
  }, [save]);

  const change = (update: (current: FirstContextAnswers) => FirstContextAnswers) => {
    setAnswers((current) => {
      if (!current) return current;
      const next = update(current);
      latest.current = next;
      dirty.current = true;
      return next;
    });
  };

  const go = (next: Step) => {
    setError(null);
    // Rows left empty are dropped when the executive moves on; a row being typed in stays.
    change((current) => withoutEmptyRows(current));
    void flush();
    setStep(next);
  };

  // Each new step starts at the top with its heading focused, so a screen reader announces where the executive is.
  // Not on the first screen: there the main button has the focus.
  const firstScreen = useRef(true);
  useEffect(() => {
    if (!state) return;
    if (firstScreen.current) { firstScreen.current = false; return; }
    document.querySelector('main')?.scrollTo?.({ top: 0 });
    heading.current?.focus();
  }, [step, state?.status]); // eslint-disable-line react-hooks/exhaustive-deps -- only a new step or status moves the focus

  // Dictation is offered only when a speech model is installed; otherwise each question would say how to get one.
  const [canDictate, setCanDictate] = useState(false);
  useEffect(() => {
    apiGet<Transcription>('/api/transcription').then((overview) => setCanDictate(dictationModels(overview).length > 0)).catch(() => {});
  }, []);

  // Leaving with answers not saved would lose them: stay, and the notice above offers to try again.
  const finishLater = async () => {
    if (await flush()) navigate('/situation');
  };

  const notNow = async () => {
    setBusy('skip');
    await flush().catch(() => {});
    await apiPost('/api/first-context/skip').catch(() => {});
    navigate('/situation');
  };

  const restart = async () => {
    setBusy('restart');
    try {
      const next = await apiPost<FirstContextState>('/api/first-context/restart');
      setState(next);
      setAnswers(next.answers);
      latest.current = next.answers;
      setStep('work');
    } catch (err) {
      setError(err instanceof Error ? serverText(err.message) : t('getStarted.couldNotStartAgain'));
    } finally {
      setBusy(null);
    }
  };

  const files = ownFiles(state?.update ?? null);

  const addFiles = async (picked: File[]) => {
    if (!picked.length) return;
    setUploadErrors([]);
    setError(null);
    const errors: string[] = [];
    try {
      const update = await apiPost<ContextUpdate>('/api/first-context/update', { title: t('getStarted.updateTitle') });
      for (let i = 0; i < picked.length; i++) {
        setBusy(t('getStarted.addingFile', { value: i + 1, length: picked.length }));
        const failed = await uploadMaterial(update.id, picked[i]!);
        if (failed) errors.push(failed);
      }
    } catch (err) {
      errors.push(err instanceof Error ? serverText(err.message) : t('getStarted.couldNotAddTheFiles'));
    }
    setUploadErrors(errors);
    try { setState(await apiGet<FirstContextState>('/api/first-context')); } catch { /* the list refreshes on the next change */ }
    setBusy(null);
  };

  const removeFile = async (name: string) => {
    const id = state?.update?.id;
    if (!id) return;
    setError(null);
    try {
      await apiDelete(`/api/context-updates/${id}/materials/${encodeURIComponent(name)}`);
      setState(await apiGet<FirstContextState>('/api/first-context'));
    } catch (err) {
      setError(err instanceof Error ? serverText(err.message) : t('getStarted.couldNotRemoveTheFile', { name }));
    }
  };

  const send = async () => {
    if (!answers) return;
    setBusy('send');
    setError(null);
    try {
      if (!(await flush())) throw new Error(t('getStarted.couldNotSend'));
      const sent = await apiPost<FirstContextState>('/api/first-context/submit', { answers: withoutEmptyRows(answers), title: t('getStarted.updateTitle') });
      const id = sent.update?.id;
      if (!id) throw new Error(t('getStarted.couldNotSend'));
      // Claude Code can run the analysis from the dashboard; the update page shows the other assistants what to type.
      if (assistant.tool === 'claude-code') {
        const runner = await apiGet<RunnerStatus>('/api/runner').catch(() => null);
        if (runner && runner.problems.length === 0) await apiPost(`/api/context-updates/${id}/run`, { command: 'analyze' }).catch(() => {});
      }
      navigate(`/context/updates/${id}`);
    } catch (err) {
      setError(err instanceof Error ? serverText(err.message) : t('getStarted.couldNotSend'));
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <main style={page}>
        <div style={card}>
          <h1 style={title}>{t('getStarted.giveAHeadStart', { assistant: assistant.label })}</h1>
          <Notice tone="critical" title={t('getStarted.couldNotLoad')} action={<Button size="sm" onClick={load}>{t('retry')}</Button>}>
            {t('getStarted.couldNotLoadHint')}
          </Notice>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
            <Button variant="ghost" onClick={() => navigate('/situation')}>{t('setup.openTheDashboard')}</Button>
          </div>
        </div>
      </main>
    );
  }
  if (!state || !answers) return <LoadingSpinner text={t('loading')} />;

  const set = <K extends 'work' | 'organization' | 'current'>(group: K, key: keyof FirstContextAnswers[K]) => (value: string) =>
    change((current) => ({ ...current, [group]: { ...current[group], [key]: value } }));
  const dictate = (fieldName: string, value: string, onChange: (value: string) => void) => (canDictate
    ? <DictateButton fieldName={fieldName} onText={(text) => onChange(withDictation(value, text))} />
    : undefined);
  /** A question as a text box with its hint, an example as placeholder, and dictation. */
  const question = (label: string, hint: string, placeholder: string, value: string, onChange: (value: string) => void, rows = 3) => (
    <Textarea label={label} hint={hint} placeholder={placeholder} value={value} onChange={onChange} rows={rows} footer={dictate(label, value, onChange)} />
  );

  const answered = (s: Step) => stepAnswered(s, answers, files.length);
  const footerBar = (primary: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 28, flexWrap: 'wrap' }}>
      <Button variant="ghost" onClick={() => go(previousStep(step))}>{t('setup.back')}</Button>
      {primary}
    </div>
  );
  // An empty step says "Skip this step" on its one button: moving on without an answer is the same thing, said honestly.
  const nextButton = (
    <Button variant={answered(step) ? 'primary' : 'secondary'} onClick={() => go(nextStep(step))}>
      {answered(step) ? t('getStarted.continue') : t('getStarted.skipThisStep')}
    </Button>
  );

  let content: React.ReactNode;

  if (state.status === 'submitted' && state.update) {
    content = (
      <>
        <h1 ref={heading} tabIndex={-1} style={title}>{t('getStarted.sentTitle', { assistant: assistant.label })}</h1>
        <p style={lead}>{t('getStarted.sentLead')}</p>
        {error && <Notice tone="critical" style={{ marginBottom: 16 }}>{error}</Notice>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Button variant="ghost" loading={busy === 'restart'} disabled={!!busy} onClick={() => void restart()}>{t('getStarted.startAgain')}</Button>
          <Button variant="primary" onClick={() => navigate(`/context/updates/${state.update!.id}`)}>{t('getStarted.openTheReview')}</Button>
        </div>
      </>
    );
  } else if (step === 'intro') {
    const resuming = state.status === 'in_progress' && (canSend(answers, files.length));
    content = (
      <>
        <h1 ref={heading} tabIndex={-1} style={title}>{t('getStarted.giveAHeadStart', { assistant: assistant.label })}</h1>
        <p style={lead}>{t('getStarted.introLead', { assistant: assistant.label })}</p>
        <ul style={{ ...list, margin: '0 0 24px', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          <li>{t('getStarted.introTime')}</li>
          <li>{t('getStarted.introSaved')}</li>
          <li>{t('getStarted.introReview')}</li>
          <li>{t('getStarted.introPrivate')}</li>
        </ul>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <Button variant="ghost" loading={busy === 'skip'} disabled={!!busy} onClick={() => void notNow()}>{t('getStarted.notNow')}</Button>
          <Button variant="primary" size="lg" onClick={() => go('work')} autoFocus>
            {resuming ? t('getStarted.continueWhereYouLeftOff') : t('getStarted.getStarted')}
          </Button>
        </div>
        <p style={{ ...muted, marginTop: 16, marginBottom: 0 }}>{t('getStarted.notNowHint')}</p>
      </>
    );
  } else if (step === 'work') {
    content = (
      <>
        <h1 ref={heading} tabIndex={-1} style={title}>{t('getStarted.workTitle')}</h1>
        <p style={lead}>{t('getStarted.workLead', { assistant: assistant.label })}</p>
        <div style={stack}>
          {question(t('getStarted.responsibilities'), t('getStarted.responsibilitiesHint'), t('getStarted.responsibilitiesExample'), answers.work.responsibilities, set('work', 'responsibilities'))}
          {question(t('getStarted.priorities'), t('getStarted.prioritiesHint'), t('getStarted.prioritiesExample'), answers.work.priorities, set('work', 'priorities'))}
          {question(t('getStarted.communicationStyle'), t('getStarted.communicationStyleHint'), t('getStarted.communicationStyleExample'), answers.work.communication_style, set('work', 'communication_style'))}
          <Input label={t('getStarted.languages')} hint={t('getStarted.languagesHint')} placeholder={t('getStarted.languagesExample')} value={answers.work.language_preferences} onChange={set('work', 'language_preferences')} />
        </div>
        {footerBar(nextButton)}
      </>
    );
  } else if (step === 'organization') {
    content = (
      <>
        <h1 ref={heading} tabIndex={-1} style={title}>{t('getStarted.organizationTitle')}</h1>
        <p style={lead}>{t('getStarted.organizationLead')}</p>
        <div style={stack}>
          {question(t('getStarted.overview'), t('getStarted.overviewHint'), t('getStarted.overviewExample'), answers.organization.overview, set('organization', 'overview'))}
          {question(t('getStarted.structure'), t('getStarted.structureHint'), t('getStarted.structureExample'), answers.organization.structure, set('organization', 'structure'))}
          {question(t('getStarted.strategy'), t('getStarted.strategyHint'), t('getStarted.strategyExample'), answers.organization.strategy, set('organization', 'strategy'))}
        </div>
        {footerBar(nextButton)}
      </>
    );
  } else if (step === 'people') {
    const people = answers.people.length ? answers.people : [emptyPerson()];
    const setPerson = (index: number, key: keyof typeof people[number]) => (value: string) =>
      change((current) => {
        const rows = current.people.length ? [...current.people] : [emptyPerson()];
        rows[index] = { ...rows[index]!, [key]: value };
        return { ...current, people: rows };
      });
    content = (
      <>
        <h1 ref={heading} tabIndex={-1} style={title}>{t('getStarted.peopleTitle')}</h1>
        <p style={lead}>{t('getStarted.peopleLead', { assistant: assistant.label })}</p>
        <div style={{ display: 'grid', gap: 12 }}>
          {people.map((person, index) => (
            <div key={index} style={row} role="group" aria-label={person.name || t('getStarted.personNumber', { number: index + 1 })}>
              <div style={rowGrid}>
                <Input label={t('getStarted.name')} value={person.name} onChange={setPerson(index, 'name')} autoFocus={index === people.length - 1 && index > 0 && !person.name} />
                <Input label={t('getStarted.role')} value={person.role} onChange={setPerson(index, 'role')} />
                <Input label={t('getStarted.theirOrganization')} value={person.organization} onChange={setPerson(index, 'organization')} />
                <Select label={t('getStarted.relationship')} value={person.relationship} onChange={setPerson(index, 'relationship')}
                  options={[{ value: '', label: t('getStarted.choose') }, ...PERSON_RELATIONSHIPS.map((value) => ({ value, label: t(`getStarted.person.${value}`) }))]} />
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <Input label={t('getStarted.whatMatters')} placeholder={t('getStarted.whatMattersExample')} value={person.notes} onChange={setPerson(index, 'notes')} />
                </div>
                {answers.people.length > 0 && <IconButton icon={icons.trash} label={t('getStarted.removePerson', { name: person.name || t('getStarted.personNumber', { number: index + 1 }) })}
                  onClick={() => change((current) => ({ ...current, people: current.people.filter((_, i) => i !== index) }))} />}
              </div>
            </div>
          ))}
          <div>
            <Button variant="secondary" onClick={() => change((current) => ({ ...current, people: [...(current.people.length ? current.people : [emptyPerson()]), emptyPerson()] }))}>
              {t('getStarted.addAPerson')}
            </Button>
          </div>
        </div>
        <p style={{ ...muted, marginTop: 12 }}>{t('getStarted.peopleTip')}</p>
        {footerBar(nextButton)}
      </>
    );
  } else if (step === 'organizations') {
    const organizations = answers.organizations.length ? answers.organizations : [emptyOrganization()];
    const setOrganization = (index: number, key: keyof typeof organizations[number]) => (value: string) =>
      change((current) => {
        const rows = current.organizations.length ? [...current.organizations] : [emptyOrganization()];
        rows[index] = { ...rows[index]!, [key]: value };
        return { ...current, organizations: rows };
      });
    content = (
      <>
        <h1 ref={heading} tabIndex={-1} style={title}>{t('getStarted.organizationsTitle')}</h1>
        <p style={lead}>{t('getStarted.organizationsLead')}</p>
        <div style={{ display: 'grid', gap: 12 }}>
          {organizations.map((organization, index) => (
            <div key={index} style={row} role="group" aria-label={organization.name || t('getStarted.organizationNumber', { number: index + 1 })}>
              <div style={rowGrid}>
                <Input label={t('getStarted.name')} value={organization.name} onChange={setOrganization(index, 'name')} autoFocus={index === organizations.length - 1 && index > 0 && !organization.name} />
                <Select label={t('getStarted.relationship')} value={organization.relationship} onChange={setOrganization(index, 'relationship')}
                  options={[{ value: '', label: t('getStarted.choose') }, ...ORGANIZATION_RELATIONSHIPS.map((value) => ({ value, label: t(`getStarted.organization.${value}`) }))]} />
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <Input label={t('getStarted.whatToKnow')} placeholder={t('getStarted.whatToKnowExample')} value={organization.notes} onChange={setOrganization(index, 'notes')} />
                </div>
                {answers.organizations.length > 0 && <IconButton icon={icons.trash} label={t('getStarted.removeOrganization', { name: organization.name || t('getStarted.organizationNumber', { number: index + 1 }) })}
                  onClick={() => change((current) => ({ ...current, organizations: current.organizations.filter((_, i) => i !== index) }))} />}
              </div>
            </div>
          ))}
          <div>
            <Button variant="secondary" onClick={() => change((current) => ({ ...current, organizations: [...(current.organizations.length ? current.organizations : [emptyOrganization()]), emptyOrganization()] }))}>
              {t('getStarted.addAnOrganization')}
            </Button>
          </div>
        </div>
        {footerBar(nextButton)}
      </>
    );
  } else if (step === 'current') {
    content = (
      <>
        <h1 ref={heading} tabIndex={-1} style={title}>{t('getStarted.currentTitle')}</h1>
        <p style={lead}>{t('getStarted.currentLead')}</p>
        <div style={stack}>
          {question(t('getStarted.programs'), t('getStarted.programsHint'), t('getStarted.programsExample'), answers.current.programs, set('current', 'programs'))}
          {question(t('getStarted.decisions'), t('getStarted.decisionsHint'), t('getStarted.decisionsExample'), answers.current.decisions, set('current', 'decisions'))}
          {question(t('getStarted.risks'), t('getStarted.risksHint'), t('getStarted.risksExample'), answers.current.risks, set('current', 'risks'))}
          {question(t('getStarted.glossary'), t('getStarted.glossaryHint'), t('getStarted.glossaryExample'), answers.current.glossary, set('current', 'glossary'), 2)}
          {question(t('getStarted.anythingElse'), t('getStarted.anythingElseHint', { assistant: assistant.label }), '', answers.notes, (notes) => change((current) => ({ ...current, notes })), 2)}
        </div>
        {footerBar(nextButton)}
      </>
    );
  } else if (step === 'files') {
    const risky = files.filter((f) => hardToRead(f.name));
    const uploading = busy !== null && busy !== 'send' && busy !== 'skip' && busy !== 'restart';
    content = (
      <>
        <h1 ref={heading} tabIndex={-1} style={title}>{t('getStarted.filesTitle')}</h1>
        <p style={lead}>{t('getStarted.filesLead', { assistant: assistant.label })}</p>
        <div style={{ display: 'grid', gap: 16 }}>
          <Notice tone="info" title={t('getStarted.whatHelpsMost')}>
            <ul style={list}>
              <li>{t('getStarted.filesOrgCharts')}</li>
              <li>{t('getStarted.filesStrategy')}</li>
              <li>{t('getStarted.filesDecks')}</li>
              <li>{t('getStarted.filesStatus')}</li>
              <li>{t('getStarted.filesNotes')}</li>
            </ul>
          </Notice>
          <DropZone onFiles={(picked) => void addFiles(picked)} />
          <p style={{ ...muted, margin: 0 }}>{t('getStarted.filesFormats', { assistant: assistant.label })}</p>
          {uploading && <p aria-live="polite" style={{ ...muted, margin: 0 }}><LoadingSpinner inline size={14} /> {busy}</p>}
          {uploadErrors.length > 0 && (
            <Notice tone="critical" title={t('getStarted.someFilesWereNotAdded')}>
              <ul style={list}>{uploadErrors.map((message) => <li key={message}>{message}</li>)}</ul>
            </Notice>
          )}
          {error && <Notice tone="critical">{error}</Notice>}
          {files.length > 0 && (
            <div>
              <div style={{ ...muted, fontWeight: 600, marginBottom: 6 }}>{t('getStarted.filesAdded', { count: files.length })}</div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
                {files.map((f) => (
                  <li key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', padding: '4px 4px 4px 10px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-sm)' }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{formatBytes(f.size)}</span>
                    <IconButton icon={icons.close} label={t('removeNamedFile', { name: f.name })} disabled={uploading} onClick={() => void removeFile(f.name)} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {risky.length > 0 && (
            <Notice tone="warning">{t('getStarted.hardToRead', { names: risky.map((f) => f.name).join(', ') })}</Notice>
          )}
        </div>
        {footerBar(
          <Button variant={files.length ? 'primary' : 'secondary'} disabled={uploading} onClick={() => go('review')}>
            {files.length ? t('getStarted.continue') : t('getStarted.skipThisStep')}
          </Button>,
        )}
      </>
    );
  } else {
    const sections: { step: Step; label: string }[] = [
      { step: 'work', label: t('getStarted.workTitle') },
      { step: 'organization', label: t('getStarted.organizationTitle') },
      { step: 'people', label: t('getStarted.peopleTitle') },
      { step: 'organizations', label: t('getStarted.organizationsTitle') },
      { step: 'current', label: t('getStarted.currentTitle') },
      { step: 'files', label: t('getStarted.filesTitle') },
    ];
    const sendable = canSend(answers, files.length);
    const unnamed = unnamedRows(answers);
    const people = answers.people.filter((p) => p.name.trim()).length;
    const organizations = answers.organizations.filter((o) => o.name.trim()).length;
    const detail = (s: Step) =>
      s === 'people' ? t('getStarted.peopleCount', { count: people })
        : s === 'organizations' ? t('getStarted.organizationsCount', { count: organizations })
          : s === 'files' ? t('getStarted.filesCount', { count: files.length }) : '';
    content = (
      <>
        <h1 ref={heading} tabIndex={-1} style={title}>{t('getStarted.reviewTitle')}</h1>
        <p style={lead}>{t('getStarted.reviewLead', { assistant: assistant.label })}</p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {sections.map((section) => {
            const done = answered(section.step);
            return (
              <li key={section.step} style={{ ...row, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{section.label}</div>
                  {done && detail(section.step) && <div style={muted}>{detail(section.step)}</div>}
                </div>
                {done ? <Badge variant="success">{section.step === 'files' ? t('getStarted.added') : t('getStarted.answered')}</Badge> : <Badge variant="default">{t('getStarted.skipped')}</Badge>}
                <Button variant="ghost" size="sm" onClick={() => go(section.step)} aria-label={t('getStarted.editSection', { section: section.label })}>
                  {done ? t('getStarted.edit') : t('getStarted.add')}
                </Button>
              </li>
            );
          })}
        </ul>
        {unnamed > 0 && <Notice tone="warning" style={{ marginTop: 16 }}>{t('getStarted.unnamedRows', { count: unnamed })}</Notice>}
        <div style={{ marginTop: 20 }}>
          <Notice tone="info" title={t('getStarted.whatHappensNext')}>
            <ol style={list}>
              <li>{t('getStarted.next1', { assistant: assistant.label })}</li>
              <li>{t('getStarted.next2')}</li>
              <li>{rich(t, 'getStarted.next3', { strong: <strong>{t('getStarted.nothingIsSavedUntil')}</strong> })}</li>
            </ol>
          </Notice>
        </div>
        {!sendable && (
          <Notice tone="warning" style={{ marginTop: 16 }} action={<Button size="sm" variant="secondary" onClick={() => void notNow()}>{t('getStarted.notNow')}</Button>}>
            {t('getStarted.nothingToSend')}
          </Notice>
        )}
        {error && <Notice tone="critical" style={{ marginTop: 16 }}>{error}</Notice>}
        {footerBar(
          <Button variant="primary" size="lg" loading={busy === 'send'} disabled={!sendable || !!busy} onClick={() => void send()}>
            {t('getStarted.organizeMyWorkspace')}
          </Button>,
        )}
      </>
    );
  }

  const number = state.status === 'submitted' ? 0 : stepNumber(step);
  return (
    <main style={page}>
      <div style={card}>
        {number > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={muted}>{t('setup.stepOf', { stepNumber: number, length: COUNTED_STEPS.length })}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span aria-live="polite" style={{ ...muted, fontSize: 'var(--text-xs)' }}>
                  {saveState === 'saving' ? t('saving') : saveState === 'saved' ? t('getStarted.saved') : ''}
                </span>
                <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void finishLater()}>{t('getStarted.finishLater')}</Button>
              </span>
            </div>
            <div role="progressbar" aria-label={t('getStarted.progress')} aria-valuemin={1} aria-valuemax={COUNTED_STEPS.length} aria-valuenow={number}
              style={{ height: 4, borderRadius: 'var(--radius-full)', background: 'var(--color-border)', overflow: 'hidden' }}>
              <div style={{ width: `${(number / COUNTED_STEPS.length) * 100}%`, height: '100%', background: 'var(--color-accent)', transition: 'width 0.2s' }} />
            </div>
          </div>
        )}
        {saveState === 'failed' && (
          <Notice tone="warning" style={{ marginBottom: 16 }} action={<Button size="sm" onClick={() => latest.current && void save(latest.current)}>{t('retry')}</Button>}>
            {t('getStarted.couldNotSave')}
          </Notice>
        )}
        {content}
      </div>
    </main>
  );
}
