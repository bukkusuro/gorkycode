import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
export function useDialogFocus(
  ref: RefObject<HTMLDivElement | null>,
  key: string | undefined,
  onClose: () => void,
) {
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!key) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>('button,input')?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const elements = [
        ...dialog.querySelectorAll<HTMLElement>('button,input,select,textarea,[tabindex="0"]'),
      ].filter((element) => !element.hasAttribute('disabled'));
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previous?.focus();
    };
  }, [ref, key]);
}
