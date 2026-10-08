'use client';

import { useState } from 'react';

export default function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
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
    </button>
  );
}
