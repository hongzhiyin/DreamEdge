import { readFile } from 'node:fs/promises';
import { webkit } from 'playwright';

const svg = await readFile('mobile/assets/app-icon.svg', 'utf8');
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0}svg{display:block}</style>${svg}`);
  await page.screenshot({ caret: 'initial', path: 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png' });
} finally { await browser.close(); }
