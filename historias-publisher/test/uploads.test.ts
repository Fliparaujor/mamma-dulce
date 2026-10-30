import { beforeEach, describe, expect, it } from 'vitest';
import { parseRange } from '../worker/services/media';
import { call, env, fakeMp4, login, resetDb, scheduleJobs, seedEpisodes, type Auth } from './helpers';

let auth: Auth;

beforeEach(async () => {
  await resetDb();
  auth = await login();
});

interface InitResponse {
  assetId: string;
  plan: { mode: string; url?: string; partSize?: number; parts?: { partNumber: number; url: string }[] };
}

async function initUpload(body: Record<string, unknown>, envOverride = {}) {
  return call('POST', '/api/uploads', { auth, body, envOverride });
}

describe('validação de arquivos no início do envio', () => {
  it.each([
    [{ filename: 'roteiro.pdf', contentType: 'application/pdf', size: 1000 }, /Formato não aceito/],
    [{ filename: 'video.mp4', contentType: 'image/png', size: 1000 }, /Tipo de arquivo não aceito/],
    [{ filename: 'video.mp4', contentType: 'video/mp4', size: 600 * 1024 * 1024 }, /passa do limite/],
    [{ filename: 'video.mp4', contentType: 'video/mp4', size: 0 }, /inválido/],
  ])('%o é recusado', async (body, message) => {
    const res = await initUpload(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(message);
  });
});

describe('envio pelo Worker (sem credenciais S3) e conclusão', () => {
  it('envia, valida a assinatura MP4 e marca como pronto', async () => {
    const data = fakeMp4(2048);
    const init = await initUpload({ filename: 'Historia_01_Ep01.mp4', contentType: 'video/mp4', size: data.length, fingerprint: 'a'.repeat(64) });
    expect(init.status).toBe(201);
    const { assetId, plan } = (await init.json()) as InitResponse;
    expect(plan.mode).toBe('proxy');

    const put = await call('PUT', plan.url!, { auth, rawBody: data, headers: { 'content-type': 'video/mp4', 'content-length': String(data.length) } });
    expect(put.status).toBe(200);
    const done = await call('POST', `/api/uploads/${assetId}/complete`, { auth, body: {} });
    expect(done.status).toBe(200);
    const row = await env.DB.prepare('SELECT status FROM media_assets WHERE id = ?').bind(assetId).first<{ status: string }>();
    expect(row!.status).toBe('ready');
  });

  it('recusa conteúdo que não é vídeo, mesmo com extensão .mp4', async () => {
    const data = new TextEncoder().encode('<html>não sou vídeo</html>');
    const { assetId, plan } = (await (await initUpload({ filename: 'falso.mp4', contentType: 'video/mp4', size: data.length })).json()) as InitResponse;
    await call('PUT', plan.url!, { auth, rawBody: data, headers: { 'content-length': String(data.length) } });
    const done = await call('POST', `/api/uploads/${assetId}/complete`, { auth, body: {} });
    expect(done.status).toBe(400);
    expect(await env.MEDIA.head(`videos/${new Date().toISOString().slice(0, 7)}/${assetId}.mp4`)).toBeNull();
  });

  it('identifica duplicado pela impressão digital', async () => {
    const data = fakeMp4(256);
    const fp = 'b'.repeat(64);
    const first = (await (await initUpload({ filename: 'a.mp4', contentType: 'video/mp4', size: data.length, fingerprint: fp })).json()) as InitResponse;
    await call('PUT', first.plan.url!, { auth, rawBody: data, headers: { 'content-length': String(data.length) } });
    await call('POST', `/api/uploads/${first.assetId}/complete`, { auth, body: {} });

    const dup = await initUpload({ filename: 'a (1).mp4', contentType: 'video/mp4', size: data.length, fingerprint: fp });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { duplicates: unknown[] }).duplicates).toHaveLength(1);
    const forced = await initUpload({ filename: 'a (1).mp4', contentType: 'video/mp4', size: data.length, fingerprint: fp, allowDuplicate: true });
    expect(forced.status).toBe(201);
  });

  it('arquivo grande vai em partes pelo Worker (multipart)', async () => {
    const part = 5 * 1024 * 1024;
    const data = new Uint8Array(part + 1000);
    data.set(fakeMp4(16), 0);
    const envOverride = { UPLOAD_MULTIPART_THRESHOLD_BYTES: String(part), UPLOAD_PART_BYTES: String(part) };
    const init = await initUpload({ filename: 'longo.mp4', contentType: 'video/mp4', size: data.length }, envOverride);
    const { assetId, plan } = (await init.json()) as InitResponse;
    expect(plan.mode).toBe('proxy-multipart');
    expect(plan.parts).toHaveLength(2);
    const etags: { partNumber: number; etag: string }[] = [];
    for (const p of plan.parts!) {
      const chunk = data.slice((p.partNumber - 1) * part, p.partNumber * part);
      const res = await call('PUT', p.url, { auth, rawBody: chunk, headers: { 'content-length': String(chunk.length) }, envOverride });
      expect(res.status).toBe(200);
      etags.push((await res.json()) as { partNumber: number; etag: string });
    }
    const done = await call('POST', `/api/uploads/${assetId}/complete`, { auth, body: { parts: etags }, envOverride });
    expect(done.status).toBe(200);
  });

  it('com credenciais S3 devolve URL pré-assinada direta para o R2, sem expor o segredo', async () => {
    const envOverride = { R2_ACCOUNT_ID: 'conta123', R2_ACCESS_KEY_ID: 'AKIDTESTE', R2_SECRET_ACCESS_KEY: 'segredo-super-secreto' };
    const res = await initUpload({ filename: 'x.mp4', contentType: 'video/mp4', size: 1000 }, envOverride);
    const { plan } = (await res.json()) as InitResponse;
    expect(plan.mode).toBe('presigned');
    const url = new URL(plan.url!);
    expect(url.hostname).toBe('conta123.r2.cloudflarestorage.com');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('21600');
    expect(plan.url).not.toContain('segredo-super-secreto');
  });
});

describe('entrega pública da mídia (/media)', () => {
  async function readyAsset() {
    const data = fakeMp4(1000);
    const { assetId, plan } = (await (await initUpload({ filename: 'ep.mp4', contentType: 'video/mp4', size: data.length })).json()) as InitResponse;
    await call('PUT', plan.url!, { auth, rawBody: data, headers: { 'content-length': String(data.length) } });
    const done = (await (await call('POST', `/api/uploads/${assetId}/complete`, { auth, body: {} })).json()) as { asset: { path: string } };
    return done.asset.path;
  }

  it('GET completo, HEAD e Range funcionam sem login', async () => {
    const path = await readyAsset();
    const full = await call('GET', path);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-length')).toBe('1000');
    expect((await full.arrayBuffer()).byteLength).toBe(1000);

    const head = await call('HEAD', path);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('1000');

    const range = await call('GET', path, { headers: { range: 'bytes=100-199' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect((await range.arrayBuffer()).byteLength).toBe(100);

    const out = await call('GET', path, { headers: { range: 'bytes=5000-' } });
    expect(out.status).toBe(416);
  });

  it('token errado ou vídeo excluído → 404', async () => {
    const path = await readyAsset();
    const wrong = path.replace(/\/[^/]+$/, '/tokenerradotokenerradotokenerrado.mp4');
    expect((await call('GET', wrong)).status).toBe(404);
    const id = path.split('/')[2]!;
    expect((await call('DELETE', `/api/media/${id}`, { auth })).status).toBe(200);
    expect((await call('GET', path)).status).toBe(404);
  });

  it('interpreta cabeçalhos Range', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ offset: 0, length: 10 });
    expect(parseRange('bytes=90-', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=-20', 100)).toEqual({ offset: 80, length: 20 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ offset: 50, length: 50 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });
});

describe('exclusão segura', () => {
  it('não apaga vídeo com publicação pendente', async () => {
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], new Date(Date.now() + 5 * 3600_000), ['instagram']);
    const asset = await env.DB.prepare('SELECT media_asset_id AS id FROM episodes WHERE id = ?').bind(ep).first<{ id: string }>();
    const res = await call('DELETE', `/api/media/${asset!.id}`, { auth });
    expect(res.status).toBe(409);
    const row = await env.DB.prepare('SELECT status FROM media_assets WHERE id = ?').bind(asset!.id).first<{ status: string }>();
    expect(row!.status).toBe('ready');
  });

  it('limpeza automática só considera mídia sem dependências e fora da retenção', async () => {
    const [a, b] = await seedEpisodes(2);
    await scheduleJobs([a!, b!], new Date(Date.now() + 5 * 3600_000), ['instagram']);
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    await env.DB.prepare(`UPDATE publication_jobs SET state = 'published', published_at = ? WHERE episode_id = ?`).bind(old, a).run();
    const res = await call('POST', '/api/media/cleanup', { auth, body: { dryRun: true } });
    const body = (await res.json()) as { candidates: { id: string }[] };
    const assetA = await env.DB.prepare('SELECT media_asset_id AS id FROM episodes WHERE id = ?').bind(a).first<{ id: string }>();
    expect(body.candidates.map((c) => c.id)).toEqual([assetA!.id]);
  });
});
