import { Capacitor } from '@capacitor/core';
import { createToolStore } from './backend';
import { createBrowserBackend } from './browser';
import { nativeBackend } from './native';

export function createFrameworkStore(applicationId: string) {
  return createToolStore(applicationId,
    Capacitor.isNativePlatform() ? nativeBackend : createBrowserBackend());
}
