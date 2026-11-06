import { useLanguage } from '@/i18n/LanguageProvider';
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal, { FormActions } from './Modal';
import Button from './Button';

/**
 * Confirmation before a destructive or irreversible action. See docs/design-system.md, "Dialogs".
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete "Q3 memo"?', message: 'This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return;
 *
 * The title names the action and its object; the message says what happens and whether it
 * can be undone; the button repeats the verb ("Delete", not "OK"). Focus starts on Cancel
 * for danger, so Enter never deletes by accident.
 */
export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<Confirm>((next) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOptions(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && <ConfirmDialog options={options} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ options, onSettle }: { options: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  const { t } = useLanguage();
  const danger = options.tone === 'danger';
  return (
    <Modal
      isOpen
      size="sm"
      role="alertdialog"
      title={options.title}
      onClose={() => onSettle(false)}
      footer={
        <FormActions>
          <Button variant="ghost" onClick={() => onSettle(false)} autoFocus={danger}>
            {options.cancelLabel ?? t('cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => onSettle(true)} autoFocus={!danger}>
            {options.confirmLabel ?? t('confirm')}
          </Button>
        </FormActions>
      }
    >
      {options.message && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-normal)', whiteSpace: 'pre-line' }}>
          {options.message}
        </div>
      )}
    </Modal>
  );
}

/** Ask before a destructive action. Falls back to the browser's confirm outside the provider (tests, isolated renders). */
export function useConfirm(): Confirm {
  const ctx = useContext(ConfirmContext);
  return (
    ctx ??
    (async (o) => window.confirm([o.title, typeof o.message === 'string' ? o.message : ''].filter(Boolean).join('\n\n')))
  );
}
