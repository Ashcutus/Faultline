import Database from 'better-sqlite3';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error('Provide an absolute path for a new backup file.');
if (existsSync(destination)) throw new Error('Backup destination already exists. Choose a new filename.');
const source = join(process.env.FAULTLINE_DATA_DIR ?? join(homedir(), '.local', 'share', 'faultline'), 'faultline.db');
if (!existsSync(source)) throw new Error('No Faultline database exists yet.');
if (resolve(destination) === resolve(source)) throw new Error('Backup destination cannot be the live database.');
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(destination);
  chmodSync(destination, 0o600);
  console.log(`Backup saved to ${destination}`);
} finally { db.close(); }
