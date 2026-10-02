import { safeStorage } from 'electron';
import type { SecretEncryption } from './vault';

export const nativeSecretEncryption: SecretEncryption = {
  supported: process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux',
  available: async () => {
    if (process.platform === 'linux' && (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend() === 'basic_text')) return false;
    return safeStorage.isAsyncEncryptionAvailable();
  },
  encrypt: value => safeStorage.encryptStringAsync(value),
  decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
};
