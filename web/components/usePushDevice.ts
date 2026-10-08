'use client';

import { useCallback, useEffect, useState } from 'react';
import { hasInstallPrompt, onInstallPromptChange, readDeviceState, type DeviceSnapshot } from '@/lib/push-client';

/**
 * State of Web Push on this device: `snapshot` is null until the first check finishes (server render and
 * hydration), then follows permission changes made in the system settings (re-read on focus).
 */
export function usePushDevice(vapidKey: string | undefined) {
  const [snapshot, setSnapshot] = useState<DeviceSnapshot | null>(null);
  const [installable, setInstallable] = useState(false);

  const refresh = useCallback(async () => {
    setSnapshot(await readDeviceState(vapidKey));
  }, [vapidKey]);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    setInstallable(hasInstallPrompt());
    return onInstallPromptChange(() => setInstallable(hasInstallPrompt()));
  }, []);

  return { snapshot, installable, refresh };
}
