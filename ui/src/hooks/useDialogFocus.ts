import { useEffect, useRef } from 'react';

// Open modals, innermost last: only the topmost one handles Escape and Tab.
const openModals: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const TEXT_ENTRY = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Moves focus into a dialog, keeps Tab inside it and closes it on Escape.
 * With `keepWhileTyping`, Escape inside a form field is left alone, so unsaved edits are not lost.
 */
export function useDialogFocus(isOpen: boolean, onClose: () => void, keepWhileTyping = false) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const me = Symbol('modal');
    openModals.push(me);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Move focus into the dialog so keys no longer reach the page behind it.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();

    const onKey = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== me) return;
      if (e.key === 'Escape') {
        if (keepWhileTyping && document.activeElement && TEXT_ENTRY.has(document.activeElement.tagName)) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null,
        );
        if (items.length === 0) {
          e.preventDefault();
          panelRef.current.focus();
          return;
        }
        const first = items[0],
          last = items[items.length - 1];
        const inside = panelRef.current.contains(document.activeElement);
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === panelRef.current || !inside)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      openModals.splice(openModals.indexOf(me), 1);
      // Back to where the user was, if that element is still on the page.
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [isOpen, keepWhileTyping]);

  return panelRef;
}
