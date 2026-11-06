import { languageName } from '@/i18n/serverText';
import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import { useNavigate } from 'react-router-dom';
import { useEffect, useId, useState } from 'react';
import Modal, { FormActions } from '@/components/common/Modal';
import Button from '@/components/common/Button';
import Input, { Checkbox, Field, FormSection, Select } from '@/components/common/Input';
import { useRecorder } from './RecordingProvider';
import { ParticipantsField } from '@/components/meetings/ParticipantsField';
import { systemAudioSupport } from '@/utils/desktop';
import { apiGet } from '@/utils/api';
import { consentSentence, defaultRecordingTitle, type RecordPrefill } from '@/utils/meetingParticipants';
import type { MeetingParticipant, SpokenLanguage, Transcription } from '@/types';


function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Starts a recording: what it is called, which microphone, and a reminder to tell the others, each time. */
export function RecordMeetingModal({ isOpen, onClose, prefill }: { isOpen: boolean; onClose: () => void; prefill: RecordPrefill | null }) {
  const { t } = useLanguage();
  const { start } = useRecorder();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  // When Record was clicked: the title this meeting starts with, and the one it keeps if the field is cleared.
  const [defaultTitle, setDefaultTitle] = useState(() => defaultRecordingTitle(new Date()));
  const titleId = useId();
  // Set when a title was just filled in: selected once it is on screen, so typing replaces it and Enter keeps it.
  const [selectTitle, setSelectTitle] = useState(false);
  const [date, setDate] = useState(today);
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [voiceCleanup, setVoiceCleanup] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [systemSupport, setSystemSupport] = useState<string | null>(null);
  const [told, setTold] = useState(false);
  // The meeting's spoken language: Settings' choice to start with, changed here for this one meeting.
  const [language, setLanguage] = useState('auto');
  const [languages, setLanguages] = useState<SpokenLanguage[]>([]);
  /** The chosen model's name, and whether this opening's Settings are read (Start waits for them). */
  const [modelName, setModelName] = useState('');
  const [allLanguages, setAllLanguages] = useState<SpokenLanguage[]>([]);
  const [languageReady, setLanguageReady] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // A new meeting each time: the last one's people must not reach this reminder.
    setTold(false);
    const named = defaultRecordingTitle(new Date());
    setDefaultTitle(named);
    setTitle(prefill?.title || named);
    setSelectTitle(true);
    setDate(today());
    setParticipants(prefill?.participants ?? []);
    void systemAudioSupport().then(setSystemSupport);
    // This meeting starts from Settings, never from the last meeting's choice; a late answer for an earlier opening is
    // not used. Without Settings, the server decides as before.
    let current = true;
    setLanguage('auto');
    setLanguages([]);
    setLanguageReady(false);
    void apiGet<Transcription>('/api/transcription').then((t) => {
      if (!current) return;
      const model = t.models.find((m) => m.id === (t.effective_model ?? t.settings.model));
      setLanguage(t.settings.language);
      setLanguages(model?.language_options ?? []);
      setModelName(model?.name ?? '');
      setAllLanguages(t.models.flatMap((m) => m.language_options ?? []));
    }).catch(() => undefined).finally(() => { if (current) setLanguageReady(true); });
    void navigator.mediaDevices?.enumerateDevices()
      .then((all) => { if (current) setDevices(all.filter((d) => d.kind === 'audioinput')); })
      .catch(() => { if (current) setDevices([]); });
    return () => { current = false; };
  }, [isOpen, prefill]);

  // After the render that shows the new title: the field already has focus (autoFocus) from before it was filled in.
  useEffect(() => {
    if (!selectTitle) return;
    setSelectTitle(false);
    const field = document.getElementById(titleId);
    if (field instanceof HTMLInputElement && document.activeElement === field) field.select();
  }, [selectTitle, titleId]);

  const startRecording = () => {
    void start({ title: title.trim() || defaultTitle, date, participants, deviceId, voiceCleanup, systemAudio: systemSupport === 'yes' && systemAudio, ...(languageReady && languages.length > 0 ? { language } : {}) });
    onClose();
    navigate('/meetings');
  };
  const microphones = devices.filter((d) => d.deviceId && d.deviceId !== 'default');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('recordMeeting')}
      description={t('recordMeetingModal.theRecordingIsTranscribedOn')}
      size="lg"
      keepWhileTyping
      footer={
        <FormActions start={!told ? <span className="gtd-field__hint">{t('recordMeetingModal.confirmThatEveryoneKnowsTo')}</span> : undefined}>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!told || !date || !languageReady} onClick={startRecording}>{t('recordMeetingModal.startRecording')}</Button>
        </FormActions>
      }
    >
      <div className="gtd-stack" style={{ gap: 'var(--space-5)' }}>
        <FormSection title={t('importUpdateModal.meeting')}>
          <div className="gtd-form-grid">
            <Input id={titleId} label={t('importUpdateModal.title')} value={title} maxLength={200} onChange={setTitle} placeholder={defaultTitle} autoFocus
              hint={prefill?.title ? undefined : t('recordMeetingModal.namedAfterWhenYouClicked')} />
            <Input label={t('updateDetail.date')} type="date" required value={date} onChange={setDate} error={!date ? t('recordMeetingModal.chooseTheDateOfThe') : undefined} />
          </div>
          <ParticipantsField value={participants} onChange={(next) => { setParticipants(next); setTold(false); }} />
          {languages.length > 0 && (
            <Field label={t('recordMeetingModal.spokenLanguage')} htmlFor="record-language"
              hint={t('recordMeetingModal.forThisMeetingOnlyThe')}>
              <select id="record-language" className="gtd-control" value={language} onChange={(e) => setLanguage(e.target.value)}
                aria-describedby="record-language-hint">
                <option value="auto">{t('recordMeetingModal.autoEachPartInIts')}</option>
                {/* A language in Settings that the model lacks: shown as it is, so what is sent is what is seen. */}
                {language !== 'auto' && !languages.some((l) => l.id === language) && (
                  <option value={language}>{rich(t, 'recordMeetingModal.notInReadAsAuto', { label: allLanguages.find((l) => l.id === language)?.label ?? language, modelName: modelName || t('recordMeetingModal.theChosenModel') })}</option>
                )}
                {languages.filter((l) => l.common || l.id === language).map((l) => <option key={l.id} value={l.id}>{languageName(l.id, l.label)}</option>)}
                {languages.some((l) => !l.common && l.id !== language) && (
                  <optgroup label={t('recordMeetingModal.otherLanguages')}>
                    {languages.filter((l) => !l.common && l.id !== language).map((l) => <option key={l.id} value={l.id}>{languageName(l.id, l.label)}</option>)}
                  </optgroup>
                )}
              </select>
            </Field>
          )}
        </FormSection>

        <FormSection title={t('recordMeetingModal.audio')}
          description={t('recordMeetingModal.theAudioIsSavedIn')}>
          <Select label={t('recordMeetingModal.microphone')} value={deviceId} onChange={setDeviceId}
            options={[{ value: '', label: t('recordMeetingModal.theSystemSDefault') }, ...microphones.map((d, i) => ({ value: d.deviceId, label: d.label || t('recordMeetingModal.microphone2', { value: i + 1 }) }))]} />
          <Checkbox checked={voiceCleanup} onChange={setVoiceCleanup} label={t('recordMeetingModal.cleanUpTheVoice')}
            description={t('recordMeetingModal.goodForALaptopMicrophone')} />
          {systemSupport === 'yes' ? (
            <Checkbox checked={systemAudio} onChange={setSystemAudio} label={t('recordMeetingModal.alsoRecordTheComputerS')}
              description={t('recordMeetingModal.theOtherPeopleInA')} />
          ) : (
            <p className="gtd-field__hint">{systemSupport ?? t('recordMeetingModal.onlyTheMicrophoneIsRecorded')}</p>
          )}
        </FormSection>

        <div className="gtd-consent">
          <Checkbox checked={told} onChange={setTold} label={consentSentence(participants)} />
        </div>
      </div>
    </Modal>
  );
}
