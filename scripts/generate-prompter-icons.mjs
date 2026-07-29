import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const root = process.cwd();
const output = path.join(root, 'assets', 'icons');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r); ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r); ctx.closePath();
}

function render(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const s = size / 64;
  ctx.scale(s, s);
  roundedRect(ctx, 3, 3, 58, 58, 12);
  ctx.fillStyle = '#101820'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(19, 48); ctx.lineTo(19, 16); ctx.lineTo(35, 16);
  ctx.bezierCurveTo(43, 16, 48, 21, 48, 28); ctx.bezierCurveTo(48, 35, 43, 40, 35, 40);
  ctx.lineTo(27, 40); ctx.lineTo(27, 48); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#101820'; roundedRect(ctx, 27, 24, 13, 8, 3); ctx.fill();
  ctx.fillStyle = '#80cbc4'; ctx.fillRect(45, 13, 6, 6);
  return canvas.toBuffer('image/png');
}

function ico(buffers) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(buffers.length, 4);
  const directory = Buffer.alloc(buffers.length * 16);
  let offset = header.length + directory.length;
  buffers.forEach(({ size, buffer }, index) => {
    const at = index * 16;
    directory[at] = size === 256 ? 0 : size; directory[at + 1] = size === 256 ? 0 : size;
    directory[at + 2] = 0; directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(buffer.length, at + 8); directory.writeUInt32LE(offset, at + 12);
    offset += buffer.length;
  });
  return Buffer.concat([header, directory, ...buffers.map(({ buffer }) => buffer)]);
}

await mkdir(output, { recursive: true });
const rendered = sizes.map((size) => ({ size, buffer: render(size) }));
await Promise.all(rendered.map(({ size, buffer }) => writeFile(path.join(output, `prompter-${size}.png`), buffer)));
await writeFile(path.join(output, 'prompter-tray.png'), rendered.find(({ size }) => size === 32).buffer);
await writeFile(path.join(output, 'prompter.ico'), ico(rendered));
const androidIcons = [
  ['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]
];
await Promise.all(androidIcons.flatMap(async ([density, size]) => {
  const folder = path.join(root, 'android', 'app', 'src', 'main', 'res', density);
  await mkdir(folder, { recursive: true });
  const buffer = render(size);
  await Promise.all(['ic_launcher.png', 'ic_launcher_round.png'].map((name) => writeFile(path.join(folder, name), buffer)));
}));
console.log(`Generated Prompter icons in ${output}`);
