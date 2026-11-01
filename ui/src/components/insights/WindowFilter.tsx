import { SegmentedControl } from '@/components/common/Tabs';


export type WindowValue = '7' | '30' | '90' | 'all';

const OPTIONS: Array<{ value: WindowValue; label: string }> = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All time' },
];

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
  return <SegmentedControl label="Time window" value={value} onChange={onChange} options={OPTIONS} />;
}
