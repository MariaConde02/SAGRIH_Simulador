/**
 * estopScope.ts — Alcance de la pausa de emergencia (TT_ESTOP) para el
 * simulador (Módulo 5 · sectorización Global o por Invernadero).
 *
 *  · `global: true`        → parada de TODO el complejo (INVER_ID NULL).
 *  · `global: false` + set → parada sectorizada: solo esos canteros (del
 *                            invernadero objetivo) deben suspenderse.
 *  · `null`                → no hay pausa activa.
 */
import { prisma } from './db.config.js';

export interface AlcancePausa {
  global: boolean;
  canteIds: Set<string>;
}

export async function alcanceDePausa(): Promise<AlcancePausa | null> {
  try {
    const activos = await prisma.tt_estop.findMany({
      where: { estop_av: true, estop_fn: { gt: new Date() } },
    });
    if (activos.length === 0) return null;

    const alcance: AlcancePausa = { global: false, canteIds: new Set<string>() };
    for (const estop of activos) {
      if (!estop.inver_id) {
        // Pausa global: cubre el complejo entero
        return { global: true, canteIds: new Set<string>() };
      }
      const canteros = await prisma.tm_cante.findMany({
        where: { inver_id: estop.inver_id, deletedAt: null },
        select: { cante_id: true },
      });
      for (const c of canteros) alcance.canteIds.add(c.cante_id);
    }
    return alcance;
  } catch (err: any) {
    console.error('[SIMULADOR] Error consultando alcance de TT_ESTOP:', err?.message ?? err);
    return null;
  }
}
