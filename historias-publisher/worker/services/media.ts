import { AwsClient } from 'aws4fetch';
import {
  ACCEPTED_VIDEO_EXTENSIONS,
  ACCEPTED_VIDEO_TYPES,
  MULTIPART_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
} from '../../shared/constants';
import { all, first, incrementUsage, nowIso, run } from '../lib/db';
import { badRequest, conflict, notFound } from '../lib/http';
import { randomToken, timingSafeEqual } from '../lib/crypto';
import { publicBaseUrl } from '../settings';
import type { Env } from '../env';

export interface MediaAssetRow {
  id: string;
  r2_key: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  fingerprint: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  status: 'uploading' | 'ready' | 'failed' | 'deleted';
  upload_mode: 'presigned' | 'multipart' | 'proxy';
  multipart_upload_id: string | null;
  public_token: string;
  created_at: string;
  uploaded_at: string | null;
  deleted_at: string | null;
}

/** Proxy pelo Worker: o plano Free da Cloudflare aceita corpos de até 100 MB por requisição. */
const PROXY_SINGLE_MAX = 95 * 1024 * 1024;
const PRESIGN_TTL_SECONDS = 6 * 3600;

export function maxUploadBytes(env: Env): number {
  const n = Number(env.MAX_UPLOAD_BYTES ?? '');
  return Number.isFinite(n) && n > 0 ? n : 500 * 1024 * 1024;
}

/** Tamanho das partes do multipart (o R2 exige no mínimo 5 MiB por parte, exceto a última). */
export function partBytes(env: Env): number {
  const n = Number(env.UPLOAD_PART_BYTES ?? '');
  return Number.isFinite(n) && n >= 5 * 1024 * 1024 ? n : MULTIPART_PART_BYTES;
}

export function multipartThreshold(env: Env): number {
  const n = Number(env.UPLOAD_MULTIPART_THRESHOLD_BYTES ?? '');
  return Number.isFinite(n) && n > 0 ? n : MULTIPART_THRESHOLD_BYTES;
}

export function canPresign(env: Env): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

export function validateVideoMeta(env: Env, filename: string, contentType: string, size: number): void {
  const lower = filename.toLowerCase();
  if (!ACCEPTED_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw badRequest(`Formato não aceito: ${filename}. Envie .mp4 ou .mov.`);
  }
  if (!(ACCEPTED_VIDEO_TYPES as readonly string[]).includes(contentType)) {
    throw badRequest(`Tipo de arquivo não aceito (${contentType || 'desconhecido'}). Envie vídeo MP4 ou MOV.`);
  }
  if (!Number.isInteger(size) || size <= 0) throw badRequest('Arquivo vazio.');
  const max = maxUploadBytes(env);
  if (size > max) throw badRequest(`Arquivo com ${(size / 1048576).toFixed(0)} MB passa do limite de ${(max / 1048576).toFixed(0)} MB.`);
}

function r2Endpoint(env: Env): string {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME ?? 'historias-publisher-media'}`;
}

function awsClient(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: 's3',
    region: 'auto',
  });
}

async function presign(env: Env, key: string, query: Record<string, string> = {}): Promise<string> {
  const url = new URL(`${r2Endpoint(env)}/${key.split('/').map(encodeURIComponent).join('/')}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set('X-Amz-Expires', String(PRESIGN_TTL_SECONDS));
  const signed = await awsClient(env).sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } });
  return signed.url;
}

export interface UploadInit {
  filename: string;
  contentType: string;
  size: number;
  fingerprint?: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
}

export type UploadPlan =
  | { mode: 'presigned'; url: string }
  | { mode: 'multipart'; partSize: number; parts: { partNumber: number; url: string }[] }
  | { mode: 'proxy'; url: string }
  | { mode: 'proxy-multipart'; partSize: number; parts: { partNumber: number; url: string }[] };

export async function findDuplicates(env: Env, init: UploadInit): Promise<{ id: string; original_filename: string }[]> {
  if (init.fingerprint) {
    return all(
      env.DB,
      `SELECT id, original_filename FROM media_assets WHERE status = 'ready' AND fingerprint = ? LIMIT 5`,
      init.fingerprint,
    );
  }
  return all(
    env.DB,
    `SELECT id, original_filename FROM media_assets WHERE status = 'ready' AND original_filename = ? AND size_bytes = ? LIMIT 5`,
    init.filename,
    init.size,
  );
}

export async function initUpload(env: Env, init: UploadInit, now = new Date()): Promise<{ assetId: string; plan: UploadPlan }> {
  validateVideoMeta(env, init.filename, init.contentType, init.size);
  const id = crypto.randomUUID();
  const ext = init.filename.toLowerCase().endsWith('.mov') ? 'mov' : 'mp4';
  const key = `videos/${now.toISOString().slice(0, 7)}/${id}.${ext}`;
  const multipart = init.size > multipartThreshold(env);
  const partSize = partBytes(env);
  const presigned = canPresign(env);

  let plan: UploadPlan;
  let uploadMode: MediaAssetRow['upload_mode'];
  let uploadId: string | null = null;

  if (multipart) {
    const mpu = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: init.contentType } });
    uploadId = mpu.uploadId;
    const count = Math.ceil(init.size / partSize);
    const parts: { partNumber: number; url: string }[] = [];
    for (let n = 1; n <= count; n++) {
      parts.push({
        partNumber: n,
        url: presigned
          ? await presign(env, key, { partNumber: String(n), uploadId })
          : `/api/uploads/${id}/parts/${n}`,
      });
    }
    plan = presigned
      ? { mode: 'multipart', partSize, parts }
      : { mode: 'proxy-multipart', partSize, parts };
    uploadMode = presigned ? 'multipart' : 'proxy';
  } else if (presigned) {
    plan = { mode: 'presigned', url: await presign(env, key) };
    uploadMode = 'presigned';
  } else {
    if (init.size > PROXY_SINGLE_MAX) throw badRequest('Arquivo grande demais para envio pelo Worker.');
    plan = { mode: 'proxy', url: `/api/uploads/${id}/body` };
    uploadMode = 'proxy';
  }

  await run(
    env.DB,
    `INSERT INTO media_assets (id, r2_key, original_filename, content_type, size_bytes, fingerprint, duration_ms, width, height,
       status, upload_mode, multipart_upload_id, public_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?)`,
    id,
    key,
    init.filename.slice(0, 255),
    init.contentType,
    init.size,
    init.fingerprint ?? null,
    init.durationMs ?? null,
    init.width ?? null,
    init.height ?? null,
    uploadMode,
    uploadId,
    randomToken(24),
    nowIso(now),
  );
  return { assetId: id, plan };
}

export async function getAsset(env: Env, id: string): Promise<MediaAssetRow> {
  const row = await first<MediaAssetRow>(env.DB, 'SELECT * FROM media_assets WHERE id = ?', id);
  if (!row) throw notFound('Vídeo não encontrado.');
  return row;
}

function assertUploading(asset: MediaAssetRow): void {
  if (asset.status !== 'uploading') throw conflict('Este envio já foi concluído ou cancelado.');
}

/** Upload simples pelo Worker (modo sem credenciais S3), transmitido sem carregar o arquivo na memória. */
export async function proxyBody(env: Env, id: string, req: Request): Promise<void> {
  const asset = await getAsset(env, id);
  assertUploading(asset);
  if (asset.upload_mode !== 'proxy' || asset.multipart_upload_id) throw badRequest('Este envio não usa o modo direto pelo Worker.');
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length !== asset.size_bytes || !req.body) throw badRequest('Tamanho do corpo diferente do informado.');
  await env.MEDIA.put(asset.r2_key, req.body, { httpMetadata: { contentType: asset.content_type } });
}

export async function proxyPart(env: Env, id: string, partNumber: number, req: Request): Promise<{ partNumber: number; etag: string }> {
  const asset = await getAsset(env, id);
  assertUploading(asset);
  if (asset.upload_mode !== 'proxy' || !asset.multipart_upload_id) throw badRequest('Este envio não usa partes pelo Worker.');
  const size = partBytes(env);
  const count = Math.ceil(asset.size_bytes / size);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) throw badRequest('Número de parte inválido.');
  const expected = partNumber < count ? size : asset.size_bytes - size * (count - 1);
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length !== expected || !req.body) throw badRequest(`Parte ${partNumber} com tamanho inesperado.`);
  const mpu = env.MEDIA.resumeMultipartUpload(asset.r2_key, asset.multipart_upload_id);
  const part = await mpu.uploadPart(partNumber, req.body);
  return { partNumber: part.partNumber, etag: part.etag };
}

/** MP4/MOV começam com uma caixa "ftyp" (ou "moov"/"wide"/"mdat" em MOV antigos) a partir do byte 4. */
export function looksLikeVideo(header: Uint8Array): boolean {
  if (header.length < 8) return false;
  const box = String.fromCharCode(header[4]!, header[5]!, header[6]!, header[7]!);
  return ['ftyp', 'moov', 'wide', 'mdat', 'free', 'skip'].includes(box);
}

export async function completeUpload(
  env: Env,
  id: string,
  parts: { partNumber: number; etag: string }[] | undefined,
  now = new Date(),
): Promise<MediaAssetRow> {
  const asset = await getAsset(env, id);
  assertUploading(asset);
  if (asset.multipart_upload_id) {
    if (!parts?.length) throw badRequest('Informe as partes enviadas.');
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const mpu = env.MEDIA.resumeMultipartUpload(asset.r2_key, asset.multipart_upload_id);
    try {
      await mpu.complete(sorted.map((p) => ({ partNumber: p.partNumber, etag: p.etag.replace(/"/g, '') })));
    } catch (e) {
      throw badRequest(`Não foi possível juntar as partes do vídeo: ${(e as Error).message}`);
    }
  }
  const head = await env.MEDIA.head(asset.r2_key);
  if (!head) throw badRequest('O arquivo não chegou ao armazenamento. Tente enviar de novo.');
  if (head.size !== asset.size_bytes) {
    await env.MEDIA.delete(asset.r2_key);
    await run(env.DB, `UPDATE media_assets SET status = 'failed' WHERE id = ?`, id);
    throw badRequest(`Tamanho armazenado (${head.size}) diferente do esperado (${asset.size_bytes}).`);
  }
  const start = await env.MEDIA.get(asset.r2_key, { range: { offset: 0, length: 16 } });
  const header = start ? new Uint8Array(await start.arrayBuffer()) : new Uint8Array();
  if (!looksLikeVideo(header)) {
    await env.MEDIA.delete(asset.r2_key);
    await run(env.DB, `UPDATE media_assets SET status = 'failed' WHERE id = ?`, id);
    throw badRequest('O conteúdo enviado não parece um vídeo MP4/MOV válido.');
  }
  await run(
    env.DB,
    `UPDATE media_assets SET status = 'ready', uploaded_at = ?, multipart_upload_id = NULL WHERE id = ? AND status = 'uploading'`,
    nowIso(now),
    id,
  );
  return getAsset(env, id);
}

export async function abortUpload(env: Env, id: string): Promise<void> {
  const asset = await getAsset(env, id);
  if (asset.status !== 'uploading') return;
  if (asset.multipart_upload_id) {
    try {
      await env.MEDIA.resumeMultipartUpload(asset.r2_key, asset.multipart_upload_id).abort();
    } catch {
      // upload já expirado/abortado
    }
  }
  await env.MEDIA.delete(asset.r2_key);
  await run(env.DB, `UPDATE media_assets SET status = 'failed' WHERE id = ?`, id);
}

/** Quantas publicações ainda vivas dependem deste vídeo. */
export async function activeDependents(env: Env, assetId: string): Promise<number> {
  const row = await first<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id
     WHERE e.media_asset_id = ? AND j.state NOT IN ('published', 'cancelled')`,
    assetId,
  );
  return row?.n ?? 0;
}

export async function deleteAsset(env: Env, id: string, now = new Date()): Promise<void> {
  const asset = await getAsset(env, id);
  if (asset.status === 'deleted') return;
  const deps = await activeDependents(env, id);
  if (deps > 0) {
    throw conflict(`Este vídeo ainda é usado por ${deps} publicação(ões) pendente(s). Cancele ou conclua antes de excluir.`);
  }
  await env.MEDIA.delete(asset.r2_key);
  await run(env.DB, `UPDATE media_assets SET status = 'deleted', deleted_at = ? WHERE id = ?`, nowIso(now), id);
}

export function mediaPath(asset: Pick<MediaAssetRow, 'id' | 'public_token' | 'r2_key'>): string {
  const ext = asset.r2_key.endsWith('.mov') ? 'mov' : 'mp4';
  return `/media/${asset.id}/${asset.public_token}.${ext}`;
}

export function mediaUrl(env: Env, asset: Pick<MediaAssetRow, 'id' | 'public_token' | 'r2_key'>, origin?: string | null): string | null {
  const base = publicBaseUrl(env, origin);
  return base ? `${base}${mediaPath(asset)}` : null;
}

// ---------- Entrega pública (/media/:id/:token.ext) ----------

export type ParsedRange = { offset: number; length: number } | 'unsatisfiable' | null;

/** Aceita um único intervalo "bytes=a-b", "bytes=a-" ou "bytes=-n". Múltiplos intervalos são ignorados (resposta completa). */
export function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(a);
  if (start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

export async function serveMedia(env: Env, req: Request, id: string, tokenWithExt: string, ctx?: ExecutionContext): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Método não permitido', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const token = tokenWithExt.replace(/\.(mp4|mov)$/i, '');
  if (!/^[0-9a-f-]{36}$/.test(id) || token.length < 20) return new Response('Não encontrado', { status: 404 });
  const asset = await first<MediaAssetRow>(env.DB, 'SELECT * FROM media_assets WHERE id = ?', id);
  if (!asset || asset.status !== 'ready' || !timingSafeEqual(token, asset.public_token)) {
    return new Response('Não encontrado', { status: 404 });
  }

  const head = await env.MEDIA.head(asset.r2_key);
  if (!head) return new Response('Não encontrado', { status: 404 });
  const size = head.size;
  const etag = head.httpEtag;
  const baseHeaders: Record<string, string> = {
    'Content-Type': asset.content_type,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': head.uploaded.toUTCString(),
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${asset.original_filename.replace(/[^\w.\- ]+/g, '_')}"`,
  };

  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const ifRange = req.headers.get('if-range');
  const rangeHeader = ifRange && ifRange !== etag ? null : req.headers.get('range');
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } });
  }

  if (method === 'HEAD') {
    return new Response(null, {
      status: range ? 206 : 200,
      headers: {
        ...baseHeaders,
        'Content-Length': String(range ? range.length : size),
        ...(range ? { 'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` } : {}),
      },
    });
  }

  const obj = await env.MEDIA.get(asset.r2_key, range ? { range } : undefined);
  if (!obj) return new Response('Não encontrado', { status: 404 });
  const usage = Promise.all([
    incrementUsage(env.DB, 'media_requests', 1),
    incrementUsage(env.DB, 'media_bytes', range ? range.length : size),
  ]).catch(() => undefined);
  if (ctx) ctx.waitUntil(usage);

  return new Response(obj.body, {
    status: range ? 206 : 200,
    headers: {
      ...baseHeaders,
      'Content-Length': String(range ? range.length : size),
      ...(range ? { 'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` } : {}),
    },
  });
}

export function ensureReadyForPublishing(asset: MediaAssetRow | null): string | null {
  if (!asset) return 'Episódio sem vídeo vinculado.';
  if (asset.status !== 'ready') return 'O vídeo do episódio não está disponível (envio incompleto ou excluído).';
  return null;
}
