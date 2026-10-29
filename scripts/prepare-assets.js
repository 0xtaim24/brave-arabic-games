// Copies the icons and fonts the UI uses into renderer/vendor so the packaged app works fully offline.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'renderer', 'vendor');

const icons = [
  'languages', 'mic', 'volume-2', 'type', 'zap', 'gauge', 'hard-drive', 'sparkles', 'shield-check', 'rotate-ccw',
  'play', 'folder-open', 'search', 'check', 'x', 'loader-circle', 'download', 'external-link', 'life-buoy', 'info',
  'settings-2', 'pencil-line', 'cpu', 'gamepad-2', 'refresh-cw', 'triangle-alert', 'heart', 'wand-sparkles',
  'scan-search', 'file-text', 'house', 'circle-check', 'circle-alert', 'save', 'undo-2', 'bot', 'audio-lines', 'rocket',
  'chevron-down', 'power',
];
const fonts = {
  '@fontsource/ibm-plex-sans-arabic': [400, 500, 600, 700].flatMap((w) => ['arabic', 'latin'].map((s) => `ibm-plex-sans-arabic-${s}-${w}-normal.woff2`)),
  '@fontsource/tajawal': [500, 700, 800].flatMap((w) => ['arabic', 'latin'].map((s) => `tajawal-${s}-${w}-normal.woff2`)),
};

fs.mkdirSync(path.join(vendor, 'icons'), { recursive: true });
fs.mkdirSync(path.join(vendor, 'fonts'), { recursive: true });

for (const name of icons) {
  const src = path.join(root, 'node_modules', 'lucide-static', 'icons', `${name}.svg`);
  if (!fs.existsSync(src)) { console.warn('missing icon', name); continue; }
  fs.copyFileSync(src, path.join(vendor, 'icons', `${name}.svg`));
}
for (const [pkg, files] of Object.entries(fonts)) {
  for (const f of files) {
    const src = path.join(root, 'node_modules', pkg, 'files', f);
    if (!fs.existsSync(src)) { console.warn('missing font', f); continue; }
    fs.copyFileSync(src, path.join(vendor, 'fonts', f));
  }
}
console.log('assets ready');
