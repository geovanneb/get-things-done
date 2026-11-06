import type { PlainMessageKey } from '../../../../server/src/i18n/messages';
import { useLanguage } from '@/i18n/LanguageProvider';
import type { OfficeCheck } from '@/types';

const TEXT: Record<OfficeCheck, { label: PlainMessageKey; title: PlainMessageKey }> = {
  encrypted: {
    label: 'officeEncrypted',
    title: 'officeEncryptedTitle',
  },
  unsupported_container: {
    label: 'officeUnreadable',
    title: 'officeUnreadableTitle',
  },
};

/** Marks an Office file agents cannot read. Renders nothing when the server reported no problem. */
export default function OfficeCheckBadge({ check }: { check?: OfficeCheck }) {
  const { t } = useLanguage();
  if (!check) return null;
  const { label, title } = TEXT[check];
  return (
    <span title={t(title)} style={{
      flexShrink: 0, padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', fontWeight: 500,
      color: 'var(--color-warning)', background: 'var(--color-warning-subtle)', border: '1px solid var(--color-warning)',
    }}>
      {t(label)}
    </span>
  );
}
