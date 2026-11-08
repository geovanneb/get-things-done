import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import qrcode from 'qrcode-generator';
import Button from '@/components/common/Button';
import Modal from '@/components/common/Modal';
import Toggle from '@/components/common/Toggle';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api';

interface Device { id: string; name: string; paired_at: string; last_seen_at: string | null }
interface Status { enabled: boolean; listening: boolean; devices: Device[] }

const QR_LIGHT = '#fff'; // design-exception: a camera reads a QR code by contrast, so it stays fixed in both themes.
const QR_DARK = '#000'; // design-exception: a camera reads a QR code by contrast, so it stays fixed in both themes.

const note: React.CSSProperties = { margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' };

/** The code is a picture of a secret, drawn here so that it never leaves this computer to be rendered. */
function PairingCode({ value }: { value: string }) {
  const { t } = useLanguage();
  const code = React.useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    return qr;
  }, [value]);
  const size = code.getModuleCount();
  const dark: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (code.isDark(row, column)) dark.push(`M${column} ${row}h1v1h-1z`);
    }
  }
  return (
    <svg role="img" aria-label={t('deviceCodeLabel')} viewBox={`-4 -4 ${size + 8} ${size + 8}`} width={240} height={240} style={{ background: QR_LIGHT, borderRadius: 'var(--radius-md)' }}>
      <path d={dark.join('')} fill={QR_DARK} />
    </svg>
  );
}

/** Settings: let a paired iPhone send meetings to this computer over the local network. */
export default function DeviceSettings() {
  const { t } = useLanguage();
  const [status, setStatus] = React.useState<Status | null>(null);
  const [code, setCode] = React.useState<string | null>(null);
  const [connected, setConnected] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    apiGet<Status>('/api/devices').then(setStatus).catch(() => setError(t('deviceLoadError')));
  }, [t]);
  React.useEffect(refresh, [refresh]);

  // The phone pairs on its own side, so the list is watched while the code is on screen.
  const paired = status?.devices.length ?? 0;
  const pairedWhenShown = React.useRef(0);
  React.useEffect(() => {
    if (!code) return undefined;
    pairedWhenShown.current = paired;
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the count is read once, when the code appears.
  }, [code, refresh]);
  React.useEffect(() => {
    if (!code || paired <= pairedWhenShown.current) return;
    // The dialog stays and says so: a window that just vanishes leaves the person guessing.
    setConnected(status?.devices[status.devices.length - 1]?.name ?? '');
    setCode(null);
  }, [code, paired, status]);

  const change = (enabled: boolean) => {
    setError(null);
    apiPut<Status>('/api/devices/enabled', { enabled }).then(setStatus).catch(() => setError(t('deviceSaveError')));
  };
  const showCode = () => {
    setError(null);
    apiPost<Record<string, unknown>>('/api/devices/pairing')
      .then((pairing) => { setCode(JSON.stringify(pairing)); refresh(); })
      .catch(() => setError(t('deviceSaveError')));
  };
  const closeCode = () => {
    setCode(null);
    void apiDelete('/api/devices/pairing').catch(() => {});
  };
  const forget = (id: string) => {
    apiDelete(`/api/devices/${encodeURIComponent(id)}`).then(refresh).catch(() => setError(t('deviceSaveError')));
  };

  if (!status) return error ? <p role="alert" style={note}>{error}</p> : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Toggle id="device-inbox" checked={status.enabled} label={t('deviceInboxLabel')} onChange={change} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <label htmlFor="device-inbox" style={{ fontSize: 'var(--text-sm)', cursor: 'pointer' }}>{t('deviceInboxLabel')}</label>
          <span style={note}>{t('deviceInboxNote')}</span>
        </span>
      </div>
      {status.devices.map((device) => (
        <div key={device.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 'var(--text-sm)' }}>{device.name}</span>
            <span style={note}>{device.last_seen_at ? t('deviceLastSeen', { date: new Date(device.last_seen_at).toLocaleString() }) : t('deviceNotSeen')}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => forget(device.id)}>{t('deviceForget')}</Button>
        </div>
      ))}
      <span><Button size="sm" variant="secondary" onClick={showCode}>{t('deviceConnect')}</Button></span>
      {error && <p role="alert" style={note}>{error}</p>}
      <Modal isOpen={code !== null} onClose={closeCode} title={t('deviceConnect')} description={t('deviceCodeHint')} size="sm">
        <div style={{ display: 'flex', justifyContent: 'center' }}>{code && <PairingCode value={code} />}</div>
      </Modal>
      <Modal
        isOpen={connected !== null}
        onClose={() => setConnected(null)}
        title={t('deviceConnected', { name: connected ?? '' })}
        description={t('deviceConnectedNote')}
        size="sm"
        footer={<Button onClick={() => setConnected(null)}>{t('deviceConnectedDone')}</Button>}
      >
        {null}
      </Modal>
    </div>
  );
}
