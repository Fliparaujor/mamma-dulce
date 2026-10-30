import { ACCEPTED_VIDEO_EXTENSIONS, ACCEPTED_VIDEO_TYPES } from '@shared/constants';
import { ApiError, getCsrfToken, post } from './api';

export type UploadPlan =
  | { mode: 'presigned'; url: string }
  | { mode: 'multipart'; partSize: number; parts: { partNumber: number; url: string }[] }
  | { mode: 'proxy'; url: string }
  | { mode: 'proxy-multipart'; partSize: number; parts: { partNumber: number; url: string }[] };

export interface VideoMeta {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

const SAMPLE = 2 * 1024 * 1024;

/** Impressão digital barata: SHA-256 de tamanho + primeiros e últimos 2 MB (não lê o arquivo inteiro). */
export async function fingerprint(file: File): Promise<string | null> {
  if (!crypto?.subtle) return null;
  const head = await file.slice(0, SAMPLE).arrayBuffer();
  const tail = file.size > SAMPLE ? await file.slice(Math.max(SAMPLE, file.size - SAMPLE)).arrayBuffer() : new ArrayBuffer(0);
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const all = new Uint8Array(sizeBytes.length + head.byteLength + tail.byteLength);
  all.set(sizeBytes, 0);
  all.set(new Uint8Array(head), sizeBytes.length);
  all.set(new Uint8Array(tail), sizeBytes.length + head.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function readVideoMeta(file: File): Promise<VideoMeta> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (meta: VideoMeta) => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(meta);
    };
    const timer = window.setTimeout(() => done({ durationMs: null, width: null, height: null }), 8000);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      done({
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      });
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      done({ durationMs: null, width: null, height: null });
    };
    video.src = url;
  });
}

export function normalizedType(file: File): string {
  if ((ACCEPTED_VIDEO_TYPES as readonly string[]).includes(file.type)) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  return file.type || 'application/octet-stream';
}

export function localValidation(file: File, maxBytes: number): string | null {
  const lower = file.name.toLowerCase();
  if (!ACCEPTED_VIDEO_EXTENSIONS.some((e) => lower.endsWith(e))) return 'Formato não aceito (envie .mp4 ou .mov).';
  if (file.size === 0) return 'Arquivo vazio.';
  if (file.size > maxBytes) return `Maior que o limite de ${Math.round(maxBytes / 1048576)} MB.`;
  return null;
}

interface PutResult {
  status: number;
  etag: string | null;
  body: string;
}

function xhrPut(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, etag: xhr.getResponseHeader('ETag'), body: xhr.responseText });
    xhr.onerror = () => reject(new Error('Falha de rede durante o envio.'));
    xhr.onabort = () => reject(new DOMException('Envio cancelado', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function putWithRetry(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
  attempts = 3,
): Promise<PutResult> {
  let last: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await xhrPut(url, body, headers, onProgress, signal);
      if (res.status >= 200 && res.status < 300) return res;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        let msg = `Envio recusado (HTTP ${res.status}).`;
        try {
          msg = (JSON.parse(res.body) as { error?: { message?: string } }).error?.message ?? msg;
        } catch {
          // corpo XML do R2 ou vazio
        }
        throw new Error(msg);
      }
      last = new Error(`Servidor respondeu ${res.status}.`);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      last = e as Error;
    }
    onProgress(0);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  throw last ?? new Error('Falha no envio.');
}

export interface UploadCallbacks {
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

/** Envia o arquivo conforme o plano devolvido pelo servidor e conclui o upload. */
export async function performUpload(file: File, assetId: string, plan: UploadPlan, cb: UploadCallbacks): Promise<void> {
  const type = normalizedType(file);
  const csrf = getCsrfToken() ?? '';
  try {
    if (plan.mode === 'presigned' || plan.mode === 'proxy') {
      const headers: Record<string, string> = { 'Content-Type': type };
      if (plan.mode === 'proxy') headers['X-CSRF-Token'] = csrf;
      await putWithRetry(plan.url, file, headers, (l) => cb.onProgress(l / file.size), cb.signal);
      await post(`/api/uploads/${assetId}/complete`, {});
      return;
    }
    const loaded = new Map<number, number>();
    const report = () => cb.onProgress([...loaded.values()].reduce((a, b) => a + b, 0) / file.size);
    const parts: { partNumber: number; etag: string }[] = [];
    const queue = [...plan.parts];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const current = p;
        const blob = file.slice((current.partNumber - 1) * plan.partSize, current.partNumber * plan.partSize);
        const headers: Record<string, string> = plan.mode === 'proxy-multipart' ? { 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' } : {};
        const res = await putWithRetry(current.url, blob, headers, (l) => {
          loaded.set(current.partNumber, l);
          report();
        }, cb.signal);
        let etag = res.etag;
        if (plan.mode === 'proxy-multipart') etag = (JSON.parse(res.body) as { etag: string }).etag;
        if (!etag) throw new Error('O armazenamento não devolveu o ETag da parte. Confira o CORS do bucket (ExposeHeaders: ETag).');
        loaded.set(current.partNumber, blob.size);
        report();
        parts.push({ partNumber: current.partNumber, etag });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, plan.parts.length) }, worker));
    await post(`/api/uploads/${assetId}/complete`, { parts });
  } catch (e) {
    void post(`/api/uploads/${assetId}/abort`, {}).catch(() => undefined);
    throw e;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Erro desconhecido.';
}
