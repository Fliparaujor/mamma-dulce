// Cliente da API GraphQL do Buffer (https://developers.buffer.com).
// Regras seguidas da documentação oficial:
// - POST em https://api.buffer.com com "Authorization: Bearer <chave>".
// - Erros de sistema vêm em `errors[].extensions.code` (UNAUTHORIZED, FORBIDDEN, NOT_FOUND, UNEXPECTED, RATE_LIMIT_EXCEEDED).
// - 429 traz Retry-After e o corpo informa a janela estourada.
// - Mutations não têm chave de idempotência: nunca repetimos createPost automaticamente aqui.

export const BUFFER_ENDPOINT = 'https://api.buffer.com';

export interface RateLimitWindow {
  name: string;
  remaining: number;
  resetSeconds: number;
  quota: number | null;
  windowSeconds: number | null;
}

export interface RateLimitSnapshot {
  capturedAt: string;
  windows: RateLimitWindow[];
}

export class BufferError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'rate_limited'
      | 'network'
      | 'server'
      | 'graphql'
      | 'budget',
    public readonly options: { code?: string; status?: number; retryAfterSeconds?: number; window?: string } = {},
  ) {
    super(message);
  }

  /** O resultado de uma mutation é desconhecido (pode ter sido aplicada). */
  get outcomeUnknown(): boolean {
    return this.kind === 'network' || this.kind === 'server';
  }
}

export interface BufferResponseMeta {
  operation: string;
  status: number;
  rateLimit: RateLimitSnapshot | null;
}

export interface BufferClientOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Chamado a cada resposta HTTP recebida (contabilidade de cota). */
  onResponse?: (meta: BufferResponseMeta) => void | Promise<void>;
  /** Limite de requisições desta instância (orçamento por execução). */
  maxRequests?: number;
  /** Pausa entre tentativas de consultas (ms). Os testes passam 0. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

interface GraphQLErrorShape {
  message?: string;
  extensions?: { code?: string; window?: string };
}

/**
 * Lê os cabeçalhos RateLimit / RateLimit-Policy. O fetch junta cabeçalhos repetidos com vírgula,
 * e o Buffer envia "; " entre os campos (exemplo da documentação: "150-in-15min";r=98;t=897).
 */
export function parseRateLimitHeaders(headers: Headers, now = new Date()): RateLimitSnapshot | null {
  const live = headers.get('ratelimit');
  if (!live) return null;
  const policy = headers.get('ratelimit-policy') ?? '';
  const policies = new Map<string, { q: number | null; w: number | null }>();
  for (const entry of policy.split(/,\s*(?=")/)) {
    const name = /"([^"]+)"/.exec(entry)?.[1];
    if (!name) continue;
    const q = /\bq=(\d+)/.exec(entry)?.[1];
    const w = /\bw=(\d+)/.exec(entry)?.[1];
    policies.set(name, { q: q ? Number(q) : null, w: w ? Number(w) : null });
  }
  const windows: RateLimitWindow[] = [];
  for (const entry of live.split(/,\s*(?=")/)) {
    const name = /"([^"]+)"/.exec(entry)?.[1];
    const r = /\br=(\d+)/.exec(entry)?.[1];
    const t = /\bt=(\d+)/.exec(entry)?.[1];
    if (!name || r === undefined) continue;
    const p = policies.get(name);
    windows.push({
      name,
      remaining: Number(r),
      resetSeconds: t ? Number(t) : 0,
      quota: p?.q ?? null,
      windowSeconds: p?.w ?? null,
    });
  }
  return windows.length ? { capturedAt: now.toISOString(), windows } : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BufferClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private requestCount = 0;

  constructor(private readonly opts: BufferClientOptions) {
    this.endpoint = opts.endpoint ?? BUFFER_ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get requestsMade(): number {
    return this.requestCount;
  }

  get remainingBudget(): number {
    return this.opts.maxRequests === undefined ? Number.POSITIVE_INFINITY : this.opts.maxRequests - this.requestCount;
  }

  /**
   * Executa uma operação GraphQL.
   * Consultas (idempotent=true) são repetidas em falha de rede/servidor; mutations não.
   */
  async request<T>(operation: string, query: string, variables: Record<string, unknown>, idempotent: boolean): Promise<T> {
    const delays = this.opts.retryDelaysMs ?? [400, 1200];
    const maxAttempts = idempotent ? delays.length + 1 : 1;
    let lastError: BufferError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.once<T>(operation, query, variables);
      } catch (err) {
        if (!(err instanceof BufferError)) throw err;
        lastError = err;
        const retryable = err.kind === 'network' || err.kind === 'server';
        if (!retryable || attempt === maxAttempts) throw err;
        await sleep(delays[attempt - 1] ?? 0);
      }
    }
    throw lastError ?? new BufferError('Falha desconhecida', 'network');
  }

  private async once<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    if (this.remainingBudget <= 0) {
      throw new BufferError('Orçamento de requisições desta execução esgotado.', 'budget');
    }
    this.requestCount++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({ operationName: operation, query, variables }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new BufferError(`Falha de rede ao chamar o Buffer (${operation}): ${(e as Error).message}`, 'network');
    } finally {
      clearTimeout(timer);
    }

    const rateLimit = parseRateLimitHeaders(res.headers);
    await this.opts.onResponse?.({ operation, status: res.status, rateLimit });

    let body: { data?: T; errors?: GraphQLErrorShape[] } | null = null;
    try {
      body = (await res.json()) as { data?: T; errors?: GraphQLErrorShape[] };
    } catch {
      body = null;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      const window = body?.errors?.[0]?.extensions?.window;
      throw new BufferError(
        `Limite de requisições do Buffer atingido${window ? ` (janela ${window})` : ''}. Tente após ${retryAfter}s.`,
        'rate_limited',
        { status: 429, retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 900, window, code: 'RATE_LIMIT_EXCEEDED' },
      );
    }
    if (res.status === 401) throw new BufferError('Chave da API do Buffer inválida ou ausente.', 'unauthorized', { status: 401 });
    if (res.status >= 500) throw new BufferError(`Buffer respondeu ${res.status} em ${operation}.`, 'server', { status: res.status });
    if (!body) throw new BufferError(`Resposta ilegível do Buffer em ${operation} (HTTP ${res.status}).`, 'server', { status: res.status });

    if (body.errors?.length) {
      const e = body.errors[0]!;
      const code = e.extensions?.code;
      const message = e.message ?? 'Erro desconhecido';
      switch (code) {
        case 'UNAUTHORIZED':
          throw new BufferError('Chave da API do Buffer inválida ou ausente.', 'unauthorized', { code });
        case 'FORBIDDEN':
          throw new BufferError(`Sem permissão no Buffer: ${message}`, 'forbidden', { code });
        case 'NOT_FOUND':
          throw new BufferError(`Não encontrado no Buffer: ${message}`, 'not_found', { code });
        case 'RATE_LIMIT_EXCEEDED':
          throw new BufferError('Limite de requisições do Buffer atingido.', 'rate_limited', {
            code,
            retryAfterSeconds: 900,
            window: e.extensions?.window,
          });
        case 'UNEXPECTED':
          throw new BufferError(`Erro inesperado no Buffer: ${message}`, 'server', { code });
        default:
          if (!body.data) throw new BufferError(`Erro GraphQL do Buffer: ${message}`, 'graphql', { code });
      }
    }
    if (!body.data) throw new BufferError(`Resposta sem dados em ${operation}.`, 'server');
    return body.data;
  }
}
