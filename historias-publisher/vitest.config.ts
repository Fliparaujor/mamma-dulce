import { pbkdf2Sync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/** Senha usada só nos testes; o hash segue o mesmo formato do script hash-password. */
export const TEST_PASSWORD = 'senha-de-teste-123';

function testPasswordHash(): string {
  const salt = randomBytes(16);
  const iterations = 10_000;
  const hash = pbkdf2Sync(TEST_PASSWORD, salt, iterations, 32, 'sha256');
  const b64 = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
      return {
        main: './worker/index.ts',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_PASSWORD,
            ADMIN_PASSWORD_HASH: testPasswordHash(),
            BUFFER_API_KEY: 'chave-falsa-de-teste',
            PUBLIC_BASE_URL: 'https://publisher.example.com',
            APP_TIMEZONE: 'America/Belem',
          },
        },
      };
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
