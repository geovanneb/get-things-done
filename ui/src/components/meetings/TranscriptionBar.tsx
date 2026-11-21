import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';

/**
 * A thin bar under a running transcription. Filled to `percent` when it is known; while it is not (converting,
 * finding who speaks without a percent, loading the model), a short stretch moves along it, slower for people who ask
 * for less motion. `spoken` is what a screen reader says of it.
 */
export function TranscriptionBar({ percent, spoken, width = '100%' }: { percent: number | null; spoken: string; width?: number | string }) {
  const { t } = useLanguage();
  return (
    <div role="progressbar" aria-label={t('transcriptionProgress.bar')} aria-valuemin={0} aria-valuemax={100} aria-valuetext={spoken}
      {...(percent === null ? {} : { 'aria-valuenow': percent })}
      className={percent === null ? 'gtd-transcription-bar gtd-transcription-bar--moving' : 'gtd-transcription-bar'} style={{ width }}>
      {percent !== null && <div style={{ width: `${percent}%` }} />}
    </div>
  );
}

/** Renders again every `ms` while `on`: a running step's time and time left move on with no new data. */
export function useTicking(on: boolean, ms = 15_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [on, ms]);
  return on ? now : Date.now();
}
