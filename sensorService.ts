import { prisma } from './db.config.js';

export class SensorService {
  /**
   * Verifica si hay un riego programado en las próximas horas para un cantero específico.
   * @param canteId ID del cantero
   * @param horas Rango de horas a buscar hacia el futuro
   */
  static async hayRiegoProximo(canteId: number, horas: number = 2): Promise<boolean> {
    const ahora = new Date();
    const formatterHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hour12: false });
    let horaActual = formatterHour.format(ahora);
    if (horaActual.startsWith('24')) horaActual = horaActual.replace('24', '00');
    
    const formatterDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Caracas', weekday: 'short' });
    const dayName = formatterDay.format(ahora);
    const dayMap: Record<string, number> = { 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6, 'Sun': 7 };
    const diaBD = dayMap[dayName] || 7;

    const programasProximos = await prisma.$queryRaw<any[]>`
      SELECT 1 FROM TT_PROGR p
      JOIN TT_PROGD d ON d.PROGR_ID = p.PROGR_ID
      WHERE p.CANTE_ID = ${canteId}
        AND p.PROGR_AT = TRUE
        AND d.PROGD_DA = ${diaBD}
        AND p.PROGR_HI::time > ${horaActual}::time
        AND p.PROGR_HI::time <= (${horaActual}::time + (${horas} * INTERVAL '1 hour'))
    `;

    return programasProximos.length > 0;
  }

  /**
   * Dispara una alerta en la base de datos
   */
  static async dispararAlerta(dispoId: string, nivel: 'baja' | 'media' | 'alta', mensaje: string) {
    const tipal = await prisma.tm_tipal.findFirst({ where: { tipal_nm: nivel } });
    await prisma.tt_alert.create({
      data: {
        dispo_id: dispoId,
        tipal_id: tipal?.tipal_id || 1,
        alert_ti: mensaje
      }
    });
  }

  /**
   * Registra un riego de emergencia en el historial
   */
  static async registrarRiegoEmergencia(canteId: number, minutos: number, caudalNominal: number) {
    const aguaUsada = caudalNominal * minutos;
    await prisma.$queryRaw`
      INSERT INTO TH_RIHRI (CANTE_ID, RIHRI_TA, RIHRI_FI, RIHRI_FF, RIHRI_VL)
      VALUES (${canteId}, 'Emergencia', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + (${minutos} * INTERVAL '1 minute'), ${Math.round(aguaUsada * 100) / 100})
    `;
  }
}
