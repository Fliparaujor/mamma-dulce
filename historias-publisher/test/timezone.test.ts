import { describe, expect, it } from 'vitest';
import { addDays, localDate, localTime, zonedToUtc } from '../shared/time';

describe('conversão de fuso horário', () => {
  it('America/Belem é UTC-3 o ano todo', () => {
    expect(zonedToUtc('2026-11-01', '12:00', 'America/Belem').toISOString()).toBe('2026-11-01T15:00:00.000Z');
    expect(zonedToUtc('2026-07-01', '19:00', 'America/Belem').toISOString()).toBe('2026-07-01T22:00:00.000Z');
  });

  it('horário local perto da meia-noite cai no dia seguinte em UTC', () => {
    expect(zonedToUtc('2026-12-31', '22:30', 'America/Belem').toISOString()).toBe('2027-01-01T01:30:00.000Z');
  });

  it('ida e volta UTC → local preserva data e hora', () => {
    const instant = zonedToUtc('2026-11-15', '19:00', 'America/Belem');
    expect(localDate(instant, 'America/Belem')).toBe('2026-11-15');
    expect(localTime(instant, 'America/Belem')).toBe('19:00');
  });

  it('respeita horário de verão em fusos que têm (America/New_York)', () => {
    expect(zonedToUtc('2026-01-15', '12:00', 'America/New_York').toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(zonedToUtc('2026-07-15', '12:00', 'America/New_York').toISOString()).toBe('2026-07-15T16:00:00.000Z');
    // 02:30 não existe em 08/03/2026 (salto das 2h para as 3h): vai para o primeiro horário válido.
    expect(zonedToUtc('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('soma dias atravessando meses e anos bissextos', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('rejeita datas impossíveis', () => {
    expect(() => zonedToUtc('2026-02-30', '12:00', 'America/Belem')).toThrow();
    expect(() => zonedToUtc('2026-02-10', '25:00', 'America/Belem')).toThrow();
  });
});
