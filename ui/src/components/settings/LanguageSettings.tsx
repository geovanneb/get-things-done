import { Select } from '../common/Input';
import Button from '../common/Button';
import { useLanguage } from '../../i18n/LanguageProvider';
import { isPreference, languages } from '../../../../server/src/i18n/locale';

export default function LanguageSettings() {
  const { t, preference, detected, loading, saving, error, change, refresh } = useLanguage();
  return <div aria-busy={loading || saving} style={{ display: 'grid', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
    <Select label={t('language')} value={preference} disabled={loading || saving}
      options={[{ value: 'auto', label: t('automatic', { language: languages[detected] }) }, ...Object.entries(languages).map(([value, label]) => ({ value, label }))]}
      onChange={value => { if (isPreference(value)) void change(value); }}
      hint={loading ? t('loading') : saving ? t('saving') : t('languageHint')}
      error={error ? t(error === 'load' ? 'languageLoadError' : 'languageSaveError') : undefined} />
    {error === 'load' && <Button onClick={refresh}>{t('retry')}</Button>}
  </div>;
}
