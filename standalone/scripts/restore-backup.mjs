import { cp, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [backupArg, dataArg, confirmation] = process.argv.slice(2);
if (!backupArg || !dataArg || confirmation !== '--confirm-restore') {
  console.error('Usage: node restore-backup.mjs <backup-directory> <data-directory> --confirm-restore');
  process.exit(2);
}
const backup = path.resolve(backupArg);
const data = path.resolve(dataArg);
const manifestFile = path.join(backup, 'manifest.json');
if (!existsSync(manifestFile) || !existsSync(path.join(backup, 'database.json'))) throw new Error('Invalid backup directory');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
await mkdir(data, { recursive: true });
await cp(path.join(backup, 'database.json'), path.join(data, 'database.json'), { force: true });
if (existsSync(path.join(backup, 'images'))) await cp(path.join(backup, 'images'), path.join(data, 'images'), { recursive: true, force: true });
console.log(`Restored backup created at ${manifest.createdAt}. Restart Standalone AI OCR.`);
