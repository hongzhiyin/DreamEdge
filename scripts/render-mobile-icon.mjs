import { readFile, copyFile } from 'node:fs/promises';
import { webkit } from 'playwright';

const browser = await webkit.launch({ headless: true });
try {
  for (const [source, size, output] of [
    ['app-icon', 1024, 'AppIcon.appiconset/AppIcon-512@2x.png'],
    ['splash', 2732, 'Splash.imageset/splash-2732x2732.png'],
  ]) {
    const svg = await readFile(`mobile/assets/${source}.svg`, 'utf8');
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0}svg{display:block}</style>${svg}`);
    await page.screenshot({ caret: 'initial', path: `ios/App/App/Assets.xcassets/${output}` });
    await page.close();
  }
  for (const suffix of ['-1', '-2']) await copyFile('ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png', `ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732${suffix}.png`);
} finally { await browser.close(); }
