import React from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const visibleFocusable = (container) => [...container.querySelectorAll(FOCUSABLE)]
  .filter((element) => element.getAttribute('aria-hidden') !== 'true'
    && !element.closest('[hidden]')
    && element.getClientRects().length > 0);

/**
 * Keeps keyboard focus inside an open modal surface, closes it with Escape and
 * returns focus to the control that opened it. `onEscape` may change while the
 * dialog is mounted (for example while an unsaved-changes confirmation is open).
 */
export function useDialogFocus(onEscape) {
  const dialogRef = React.useRef(null);
  const onEscapeRef = React.useRef(onEscape);
  onEscapeRef.current = onEscape;

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusInitial = () => {
      const initial = dialog.querySelector('[data-dialog-initial-focus]')
        || visibleFocusable(dialog)[0]
        || dialog;
      initial.focus({ preventScroll: true });
    };
    const frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(focusInitial)
      : setTimeout(focusInitial, 0);

    const keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = visibleFocusable(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);

    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      else clearTimeout(frame);
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  return dialogRef;
}

export function handleTabListKeyDown(event, values, selected, onSelect) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = Math.max(0, values.indexOf(selected));
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? values.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + values.length) % values.length;
  onSelect(values[next]);
  const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
  tabs[next]?.focus();
}
