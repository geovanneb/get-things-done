import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { SegmentedControl } from '@/components/common/Tabs';


export type WindowValue = '7' | '30' | '90' | 'all';

const OPTIONS = (): Array<{ value: WindowValue; label: string }> => ([
  { value: '7', label: tr('windowFilter.7Days') },
  { value: '30', label: tr('windowFilter.30Days') },
  { value: '90', label: tr('windowFilter.90Days') },
  { value: 'all', label: tr('windowFilter.allTime') },
]);

/**
 * The one filter row. It sits above every panel and scopes all of them at once
 * — a per-card filter would let two panels disagree about what "now" means.
 */
export default function WindowFilter({
  value,
  onChange,
}: {
  value: WindowValue;
  onChange: (value: WindowValue) => void;
}) {
  const { t } = useLanguage();
  return <SegmentedControl label={t('windowFilter.timeWindow')} value={value} onChange={onChange} options={OPTIONS()} />;
}
