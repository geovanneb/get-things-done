import React, { useId } from 'react';
import ReactDOM from 'react-dom';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import IconButton, { icons } from './IconButton';

/**
 * Every dialog. See docs/design-system.md, "Dialogs".
 *
 *  sm  420px  confirmations and one-question prompts
 *  md  560px  short forms (the default)
 *  lg  720px  forms with several groups
 *  xl  960px  editors and previews
 *
 * On a phone every size takes the full width and sits at the bottom of the screen.
 * The footer holds the actions and stays visible while the body scrolls: Cancel
 * (ghost) first, the primary action last.
 */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: ModalSize;
  /** Escape inside a form field does not close the dialog, so typing is not lost. */
  keepWhileTyping?: boolean;
  /** For an alertdialog (a destructive confirmation). */
  role?: 'dialog' | 'alertdialog';
}

export default function Modal({ isOpen, onClose, title, description, children, footer, size = 'md', keepWhileTyping, role = 'dialog' }: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useDialogFocus(isOpen, onClose, keepWhileTyping);

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <div
      className="gtd-modal"
      role={role}
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
    >
      <div className="gtd-modal__scrim" aria-hidden="true" onClick={onClose} />
      <div ref={panelRef} role="document" tabIndex={-1} className={`gtd-modal__panel gtd-modal__panel--${size}`}>
        {title && (
          <div className="gtd-modal__header">
            <div style={{ minWidth: 0 }}>
              <h2 id={titleId} className="gtd-modal__title">{title}</h2>
              {description && <p id={descriptionId} className="gtd-modal__description">{description}</p>}
            </div>
            <IconButton label="Close dialog" icon={icons.close} onClick={onClose} />
          </div>
        )}
        <div className="gtd-modal__body">{children}</div>
        {footer && <div className="gtd-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/** The action row of a form or dialog: optional start actions, then Cancel and the primary action. */
export function FormActions({ start, children, style }: { start?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="gtd-form-actions" style={style}>
      {start && <div className="gtd-form-actions__start">{start}</div>}
      {children}
    </div>
  );
}
