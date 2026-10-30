#!/usr/bin/env node
// Gera o hash da senha do administrador no formato aceito pelo Worker:
//   pbkdf2-sha256$<iterações>$<sal>$<hash>
// Uso: npm run hash-password            (pede a senha sem mostrar na tela)
//      npm run hash-password -- --iterations 100000
//
// Padrão: 10.000 iterações. Medido no runtime dos Workers: ~8 ms de CPU por login, dentro do limite
// de 10 ms do plano Free. 100.000 iterações (~70 ms) só cabem no Workers Paid. O hash fica guardado
// apenas como segredo da Cloudflare e o login tem limite de tentativas; mesmo assim, use uma senha
// longa (frase com 4+ palavras ou 16+ caracteres aleatórios).
// Salve a saída como segredo: npx wrangler secret put ADMIN_PASSWORD_HASH
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const itIdx = args.indexOf('--iterations');
const iterations = itIdx >= 0 ? Number(args[itIdx + 1]) : 10_000;
if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 100_000) {
  console.error('Iterações devem ficar entre 10.000 e 100.000 (limite do PBKDF2 no Workers).');
  process.exit(1);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput?.bind(rl);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    // Esconde a digitação
    rl._writeToOutput = (s) => (s.includes(question) ? write?.(s) : write?.('*'));
  });
}

const password = process.env.ADMIN_PASSWORD ?? (await ask('Nova senha do administrador: '));
if (!password || password.length < 14) {
  console.error('Use uma senha com pelo menos 14 caracteres (de preferência uma frase longa).');
  process.exit(1);
}
const b64 = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
console.log(`pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`);
