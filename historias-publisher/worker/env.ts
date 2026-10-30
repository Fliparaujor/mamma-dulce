export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS?: Fetcher;

  // Variáveis públicas (wrangler.jsonc → vars)
  APP_TIMEZONE?: string;
  R2_BUCKET_NAME?: string;
  MAX_UPLOAD_BYTES?: string;
  /** URL pública HTTPS do Worker (ex.: https://historias-publisher.SEU-SUBDOMINIO.workers.dev). */
  PUBLIC_BASE_URL?: string;

  // Segredos (wrangler secret put …). Nunca chegam ao navegador.
  ADMIN_PASSWORD_HASH?: string;
  BUFFER_API_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  /** Avançado: tamanho das partes e limite para upload multipart (bytes). */
  UPLOAD_PART_BYTES?: string;
  UPLOAD_MULTIPART_THRESHOLD_BYTES?: string;

  /** Somente testes: endpoint alternativo do Buffer. Ignorado em produção se não for HTTPS. */
  BUFFER_API_URL?: string;
}
