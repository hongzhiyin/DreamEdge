import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.hongzhiyin.ideadock',
  appName: 'IdeaDock',
  webDir: 'dist/mobile',
  ios: { contentInset: 'never', preferredContentMode: 'mobile' },
};

export default config;
