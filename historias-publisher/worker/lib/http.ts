import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'error',
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, 'bad_request', details);
}

export function notFound(message = 'Não encontrado.'): HttpError {
  return new HttpError(404, message, 'not_found');
}

export function conflict(message: string, details?: unknown): HttpError {
  return new HttpError(409, message, 'conflict', details);
}

/** Valida dados de entrada com um schema zod, devolvendo mensagens em português. */
export function parseWith<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw badRequest(first ? `Dado inválido${first.path ? ` em "${first.path}"` : ''}: ${first.message}` : 'Dados inválidos.', issues);
  }
  return result.data;
}

export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw badRequest('Envie o corpo em JSON.');
  try {
    return await req.json();
  } catch {
    throw badRequest('JSON malformado.');
  }
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'desconhecido';
}
