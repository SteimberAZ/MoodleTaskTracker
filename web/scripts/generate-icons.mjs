// Generates the PNG icons (PWA + iOS home screen) from the single SVG source `app/icon.svg`.
// Run with `npm run icons`. The PNGs are committed, so this only needs to run when the mark changes.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'app', 'icon.svg');
const OUT_DIR = path.join(root, 'public', 'icons');

// Dark theme background (--bg in globals.css): installed icons always sit on it.
const BACKGROUND = '#000000';
// Renderers used here ignore prefers-color-scheme, so the dark palette is applied explicitly.
const DARK_STYLE =
  '<style>.c{fill:#e8946c}.h{fill:#fff;opacity:.3}.f{fill:#000;opacity:.22}.m{fill:#f5f2e9}.t{stroke:#f5f2e9;fill:none}</style>';

/** Inner markup of the source SVG without its own <style> (the 64x64 mark). */
async function readMark() {
  const svg = await readFile(SOURCE, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return inner.replace(/<style>[\s\S]*?<\/style>/, '');
}

/**
 * Square canvas with the dark background and the mark centered.
 * `markScale` is the mark's height as a share of the canvas; `radius` rounds the canvas (0 = full bleed).
 */
function compose(mark, size, markScale, radius) {
  const box = size * markScale;
  const offset = (size - box) / 2;
  const rx = Math.round(size * radius);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
${DARK_STYLE}
<rect width="${size}" height="${size}" rx="${rx}" fill="${BACKGROUND}"/>
<g transform="translate(${offset} ${offset}) scale(${box / 64})">${mark}</g>
</svg>`;
}

const TARGETS = [
  // "any" purpose: rounded dark tile, mark at ~72%.
  { file: 'icon-192.png', size: 192, markScale: 0.72, radius: 0.22 },
  { file: 'icon-512.png', size: 512, markScale: 0.72, radius: 0.22 },
  // Maskable: full-bleed background, mark inside the safe zone (~62%).
  { file: 'icon-maskable-512.png', size: 512, markScale: 0.62, radius: 0 },
  // iOS home screen: opaque square (iOS applies its own rounding), mark at ~66%.
  { file: 'apple-touch-icon.png', size: 180, markScale: 0.66, radius: 0 },
];

// Android status-bar badge for push notifications: only the alpha channel is used, so the mark is flat
// white on a transparent canvas (no facets) and keeps some padding.
const BADGE_STYLE = '<style>.c,.m{fill:#fff}.h,.f{opacity:0}.t{stroke:#fff;fill:none}</style>';
const BADGE = { file: 'badge-96.png', size: 96, markScale: 0.84 };

function composeBadge(mark, size, markScale) {
  const box = size * markScale;
  const offset = (size - box) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
${BADGE_STYLE}
<g transform="translate(${offset} ${offset}) scale(${box / 64})">${mark}</g>
</svg>`;
}

async function render(svg, size) {
  return sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

const mark = await readMark();
await mkdir(OUT_DIR, { recursive: true });

for (const { file, size, markScale, radius } of TARGETS) {
  const png = await render(compose(mark, size, markScale, radius), size);
  await writeFile(path.join(OUT_DIR, file), png);
  // iOS (and crawlers) also probe /apple-touch-icon.png at the site root.
  if (file === 'apple-touch-icon.png') await writeFile(path.join(root, 'public', file), png);
  console.log(`${path.relative(root, path.join(OUT_DIR, file))} ${size}x${size} ${png.length} bytes`);
}

const badge = await render(composeBadge(mark, BADGE.size, BADGE.markScale), BADGE.size);
await writeFile(path.join(OUT_DIR, BADGE.file), badge);
console.log(`${path.relative(root, path.join(OUT_DIR, BADGE.file))} ${BADGE.size}x${BADGE.size} ${badge.length} bytes`);
