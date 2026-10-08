'use client';

import { useState } from 'react';
import LiveStatus from './LiveStatus';

/**
 * Copies `text` to the clipboard. The accessible name is the visible label plus `context` (visually hidden), so
 * several "Copiar" buttons on one page are told apart; short texts such as invite codes are their own context.
 */
export default function CopyButton({ text, label = 'Copiar', context }: { text: string; label?: string; context?: string }) {
  const [copied, setCopied] = useState(false);
  const hidden = context ?? (text.length <= 24 ? text : undefined);
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard unavailable (insecure context or denied): the code stays selectable on screen.
          }
        }}
      >
        {copied ? 'Copiado' : label}
        {hidden && <span className="sr-only"> {hidden}</span>}
      </button>
      <LiveStatus message={copied ? 'Copiado' : ''} />
    </>
  );
}
