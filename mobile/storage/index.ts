import { Capacitor } from '@capacitor/core';
import { createToolStore } from './backend';
import { createBrowserBackend } from './browser';
import { nativeBackend } from './native';

export const readingStore = createToolStore('reading-log',
  Capacitor.isNativePlatform() ? nativeBackend : createBrowserBackend());
