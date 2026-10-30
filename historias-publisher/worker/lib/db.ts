export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

/** Número de linhas alteradas por um UPDATE/INSERT/DELETE. */
export function changes(res: D1Result): number {
  return res.meta?.changes ?? 0;
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export async function incrementUsage(db: D1Database, metric: string, by = 1, now = new Date()): Promise<void> {
  await run(
    db,
    `INSERT INTO usage_daily (day, metric, value) VALUES (?, ?, ?)
     ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value`,
    utcDay(now),
    metric,
    by,
  );
}

export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
