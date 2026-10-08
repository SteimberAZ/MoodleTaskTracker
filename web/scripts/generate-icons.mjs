// Generates the PNG icons (PWA + iOS home screen + Android themed/badge) from the same logo the app header uses
// (`public/brand/logo-dark.svg`, the variant drawn for dark backgrounds). Run with `npm run icons`.
// The PNGs are committed, so this only needs to run when the logo changes.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'public', 'brand', 'logo-dark.svg');
const OUT_DIR = path.join(root, 'public', 'icons');

// Dark theme background (--bg in globals.css): installed icons always sit on it. iOS home-screen icons are one
// static PNG with no dark variant, so the dark logo on this background is the one that reads everywhere.
const BACKGROUND = '#000000';

// The logo's own coordinate box (matches the viewBox of the source SVG).
const VB = { x: 56, y: -28, w: 400, h: 484 };

/** Inner markup of the source SVG (defs, crystal, cap), without the outer <svg> element. */
async function readMark() {
  const svg = await readFile(SOURCE, 'utf8');
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

/** Same mark with every paint replaced by flat white (cap and crystal keep the gap the mask cuts between them). */
function toSilhouette(mark) {
  return mark.replace(/#b0603c/gi, '#fff').replace(/#f5f2e9/gi, '#fff');
}

/** `<g>` that fits the logo box into a square canvas, centered, with the mark `markScale` as tall as the canvas. */
function placeMark(mark, size, markScale) {
  const s = (size * markScale) / VB.h;
  const tx = (size - VB.w * s) / 2 - VB.x * s;
  const ty = (size - VB.h * s) / 2 - VB.y * s;
  return `<g transform="translate(${tx} ${ty}) scale(${s})">${mark}</g>`;
}

function wrap(size, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
}

/** Opaque dark canvas (optionally rounded) with the logo centered. `radius` is a share of the size; 0 = full bleed. */
function composeOnDark(mark, size, markScale, radius) {
  const rx = Math.round(size * radius);
  return wrap(size, `<rect width="${size}" height="${size}" rx="${rx}" fill="${BACKGROUND}"/>${placeMark(mark, size, markScale)}`);
}

/** Transparent canvas with the flat white silhouette: only the alpha channel is used by the OS. */
function composeSilhouette(mark, size, markScale) {
  return wrap(size, placeMark(toSilhouette(mark), size, markScale));
}

async function render(svg, size, opaque) {
  let img = sharp(Buffer.from(svg), { density: 384 }).resize(size, size);
  // Full-bleed icons drop the alpha channel entirely (iOS paints transparency black and applies its own rounding).
  if (opaque) img = img.flatten({ background: BACKGROUND });
  return img.png({ compressionLevel: 9 }).toBuffer();
}

const mark = await readMark();
await mkdir(OUT_DIR, { recursive: true });

const TARGETS = [
  // "any" purpose: rounded dark tile, logo ~72% of the tile height.
  { file: 'icon-192.png', size: 192, svg: () => composeOnDark(mark, 192, 0.72, 0.22) },
  { file: 'icon-512.png', size: 512, svg: () => composeOnDark(mark, 512, 0.72, 0.22) },
  // Maskable: full-bleed background, logo (~60% tall) well inside the 80% safe-zone circle.
  { file: 'icon-maskable-512.png', size: 512, svg: () => composeOnDark(mark, 512, 0.6, 0), opaque: true },
  // Android 13+ themed icon: single-color silhouette on transparent, same safe-zone sizing as maskable.
  { file: 'icon-monochrome-512.png', size: 512, svg: () => composeSilhouette(mark, 512, 0.6) },
  // iOS home screen: opaque square (iOS applies its own rounding), logo ~66%.
  { file: 'apple-touch-icon.png', size: 180, svg: () => composeOnDark(mark, 180, 0.66, 0), opaque: true, alsoAtRoot: true },
  // Android status-bar badge for push notifications: white silhouette on transparent, small padding.
  { file: 'badge-96.png', size: 96, svg: () => composeSilhouette(mark, 96, 0.84) },
];

for (const { file, size, svg, opaque, alsoAtRoot } of TARGETS) {
  const png = await render(svg(), size, opaque);
  await writeFile(path.join(OUT_DIR, file), png);
  // iOS (and crawlers) also probe /apple-touch-icon.png at the site root.
  if (alsoAtRoot) await writeFile(path.join(root, 'public', file), png);
  console.log(`${path.relative(root, path.join(OUT_DIR, file))} ${size}x${size} ${png.length} bytes`);
}
