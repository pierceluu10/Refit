import { Check, Copy } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { COPY_FEEDBACK_DURATION } from '../data';

export function CopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'denied'>('idle');
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timeout.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setStatus('idle'), COPY_FEEDBACK_DURATION);
    } catch (error) {
      if (error instanceof DOMException || !navigator.clipboard) setStatus('denied');
      else throw error;
    }
  }
  return (
    <span className="copy-control">
      <button
        className="icon-button"
        onClick={copy}
        aria-label={status === 'copied' ? 'Copied configuration' : 'Copy configuration'}
      >
        {status === 'copied' ? <Check /> : <Copy />}
      </button>
      <span className={status === 'denied' ? 'copy-error' : 'sr-only'} role="status">
        {status === 'copied'
          ? 'Copied to clipboard'
          : status === 'denied'
            ? 'Clipboard unavailable. Select and copy the code.'
            : ''}
      </span>
    </span>
  );
}
