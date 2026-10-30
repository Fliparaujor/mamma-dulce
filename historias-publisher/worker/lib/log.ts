// Logs estruturados. Qualquer chave com cara de credencial é mascarada antes de sair.

const SENSITIVE_KEY = /(authorization|password|senha|secret|token|api[_-]?key|cookie|signature|x-amz)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[profundo]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[oculto]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Mascara assinaturas de URLs pré-assinadas e tokens Bearer que escapem em mensagens.
    return value
      .replace(/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"]+/gi, '$1[oculto]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [oculto]');
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

export function log(level: Level, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...(redact(data) as Record<string, unknown>) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
