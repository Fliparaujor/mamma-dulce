#!/usr/bin/env node
// Exporta o banco D1 de produção para backups/AAAA-MM-DD-HHMM.sql usando o Wrangler.
// Uso: npm run db:backup            (banco remoto)
//      npm run db:backup -- --local (banco local do wrangler dev)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const local = process.argv.includes('--local');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const dir = path.resolve('backups');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${stamp}${local ? '-local' : ''}.sql`);
execFileSync('npx', ['wrangler', 'd1', 'export', 'historias-publisher', local ? '--local' : '--remote', `--output=${file}`], { stdio: 'inherit' });
console.log(`Backup salvo em ${file}`);
console.log('Guarde este arquivo fora do computador (ex.: Google Drive). Ele contém o calendário e as legendas, sem senhas nem chaves.');
