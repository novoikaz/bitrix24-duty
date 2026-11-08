import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'bitrix24-duty-static');
const archive = join(root, 'dist', 'bitrix24-duty-static.zip');

await rm(output, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(output, { recursive: true });

let index = await readFile(join(root, 'public', 'index.html'), 'utf8');
index = index.replace('<script src="/app.js"></script>', '<script src="./bitrix-static.js"></script><script src="./app.js"></script>');
await writeFile(join(output, 'index.html'), index);
await cp(join(root, 'public', 'app.js'), join(output, 'app.js'));
await cp(join(root, 'public', 'calendar-redesign.css'), join(output, 'calendar-redesign.css'));
await cp(join(root, 'static-app-src', 'bitrix-static.js'), join(output, 'bitrix-static.js'));
await cp(join(root, 'static-app-src', 'install.html'), join(output, 'install.html'));

execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: output });
console.log(archive);
