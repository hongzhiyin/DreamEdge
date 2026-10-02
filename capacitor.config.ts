import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.hongzhiyin.dreamedge',
  appName: 'DreamEdge',
  webDir: 'dist/mobile',
  ios: { contentInset: 'never', preferredContentMode: 'mobile' },
};

export default config;
