/**
 * alerts.ts — Verificación de umbrales y alertas automáticas, además de ejecución de riegos.
 * Implementa M2.4: alertas automáticas de tanque (media/crítica) y humedad.
 */
import { prisma, cargarCache } from './db.config.js';

function ts() {
  return `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`;
}

// ─── M2.4: Alertas automáticas ───────────────────────────────────────────────
export async function verificarAlertas() {
  try {
    const { sensores, params } = await cargarCache();
    if (sensores.length === 0) return;

    const capacidad      = parseFloat(params.TANQUE_CAPACIDAD || '10000');
    const alertaBajaPct  = parseFloat(params.TANQUE_ALERTA_BAJA     || '20') / 100;
    const alertaCritPct  = parseFloat(params.TANQUE_ALERTA_CRITICA  || '10') / 100;
    const humedadMinCrit = parseFloat(params.HUMEDAD_MIN_CRITICO     || '35');
    const humedadOptInf  = parseFloat(params.HUMEDAD_OPTIMO_INFERIOR || '55');
    const humedadOptSup  = parseFloat(params.HUMEDAD_OPTIMO_SUPERIOR || '85');

    // ── Alerta de Tanque ──────────────────────────────────────────────────────
    const sensoresTanque = sensores.filter((s: any) => s.tipod_nm === 'Sensor Nivel Tanque');
    for (const s of sensoresTanque) {
      const res = await prisma.tt_lectu.findFirst({
        where: { dispo_id: s.dispo_id },
        orderBy: { lectu_fh: 'desc' }
      });
      if (!res) continue;

      const nivel = Number(res.lectu_vl);
      const pct   = nivel / capacidad;

      if (pct <= alertaCritPct) {
        // Nivel crítico
        const existe = await prisma.tt_alert.findFirst({
          where: {
            dispo_id: s.dispo_id,
            alert_ea: 'activa',
            alert_ti: { startsWith: 'Nivel de tanque CRÍTICO' }
          }
        });
        if (!existe) {
          const tipal = await prisma.tm_tipal.findFirst({ where: { tipal_nm: 'crítica' } });
          await prisma.tt_alert.create({
            data: {
              dispo_id: s.dispo_id,
              tipal_id: tipal?.tipal_id || 1,
              alert_ti: `Nivel de tanque CRÍTICO: ${Math.round(nivel)}L (${Math.round(pct * 100)}% de capacidad)`
            }
          });
          console.log(`${ts()} 🚨 ALERTA CRÍTICA: Tanque al ${Math.round(pct * 100)}%`);
        }
      } else if (pct <= alertaBajaPct) {
        // Nivel bajo
        const existe = await prisma.tt_alert.findFirst({
          where: {
            dispo_id: s.dispo_id,
            alert_ea: 'activa',
            alert_ti: { startsWith: 'Nivel de tanque bajo' }
          }
        });
        if (!existe) {
          const tipal = await prisma.tm_tipal.findFirst({ where: { tipal_nm: 'media' } });
          await prisma.tt_alert.create({
            data: {
              dispo_id: s.dispo_id,
              tipal_id: tipal?.tipal_id || 2,
              alert_ti: `Nivel de tanque bajo: ${Math.round(nivel)}L (${Math.round(pct * 100)}% de capacidad)`
            }
          });
          console.log(`${ts()} ⚠️  ALERTA MEDIA: Tanque al ${Math.round(pct * 100)}%`);
        }
      }
    }

    // ── Alertas de Humedad de Suelo ───────────────────────────────────────────
    const sensoresHum = sensores.filter((s: any) => s.tipod_nm === 'Sensor Humedad');
    for (const s of sensoresHum) {
      const res = await prisma.tt_lectu.findFirst({
        where: {
          dispo_id: s.dispo_id,
          tm_unidm: { unidm_ab: '%' }
        },
        orderBy: { lectu_fh: 'desc' }
      });
      if (!res) continue;

      const hum = Number(res.lectu_vl);
      const tag = s.dispo_tg || s.dispo_id;

      if (hum < humedadMinCrit) {
        // Humedad crítica
        const existe = await prisma.tt_alert.findFirst({
          where: {
            dispo_id: s.dispo_id,
            alert_ea: 'activa',
            alert_ti: { startsWith: 'Humedad crítica' }
          }
        });
        if (!existe) {
          const tipal = await prisma.tm_tipal.findFirst({ where: { tipal_nm: 'crítica' } });
          await prisma.tt_alert.create({
            data: {
              dispo_id: s.dispo_id,
              tipal_id: tipal?.tipal_id || 1,
              alert_ti: `Humedad crítica en ${tag}: ${hum.toFixed(1)}% (mínimo seguro: ${humedadMinCrit}%)`
            }
          });
          console.log(`${ts()} 🚨 ALERTA CRÍTICA: Humedad ${hum.toFixed(1)}% en ${tag}`);
        }
      } else if (hum < humedadOptInf) {
        // Humedad baja
        const existe = await prisma.tt_alert.findFirst({
          where: {
            dispo_id: s.dispo_id,
            alert_ea: 'activa',
            alert_ti: { startsWith: 'Humedad baja' }
          }
        });
        if (!existe) {
          const tipal = await prisma.tm_tipal.findFirst({ where: { tipal_nm: 'media' } });
          await prisma.tt_alert.create({
            data: {
              dispo_id: s.dispo_id,
              tipal_id: tipal?.tipal_id || 2,
              alert_ti: `Humedad baja en ${tag}: ${hum.toFixed(1)}% (óptimo: ${humedadOptInf}-${humedadOptSup}%)`
            }
          });
          console.log(`${ts()} ⚠️  ALERTA MEDIA: Humedad baja ${hum.toFixed(1)}% en ${tag}`);
        }
      }
    }

  } catch (error: any) {
    console.error(`${ts()} Error verificando alertas:`, error.message);
  }
}

// ─── Programas de Riego Automático ───────────────────────────────────────────
export async function verificarProgramasRiego() {
  try {
    const { params } = await cargarCache();
    const bombaActiva = params.BOMBA_ACTIVA === 'true';
    if (!bombaActiva) return;

    const hoy        = new Date().getDay();
    const diaBD      = hoy === 0 ? 7 : hoy; // Domingo = 7
    const horaActual = new Date().toTimeString().substring(0, 5);

    const programas = await prisma.$queryRaw<any[]>`
      SELECT p.PROGR_ID, p.CANTE_ID, p.PROGR_HI, p.PROGR_DR
       FROM TT_PROGR p
       JOIN TT_PROGD d ON d.PROGR_ID = p.PROGR_ID
       WHERE d.PROGD_DA = ${diaBD}
         AND p.PROGR_HI <= ${horaActual}::time
         AND p.PROGR_HI > (${horaActual}::time - INTERVAL '30 seconds')
         AND p.PROGR_AT = TRUE
    `;

    for (const prog of programas) {
      const yaEjecutado = await prisma.$queryRaw<any[]>`
        SELECT 1 FROM TH_RIHRI
         WHERE CANTE_ID = ${prog.cante_id} AND PROGR_ID = ${prog.progr_id}
           AND RIHRI_FI > CURRENT_TIMESTAMP - INTERVAL '2 minutes'
      `;
      if (yaEjecutado.length > 0) continue;

      const caudal    = parseFloat(params.RIEGO_CAUDAL_NOMINAL || '1.2');
      const aguaUsada = caudal * prog.progr_dr;

      await prisma.$queryRaw`
        INSERT INTO TH_RIHRI (CANTE_ID, RIHRI_TA, RIHRI_FI, RIHRI_FF, RIHRI_VL, PROGR_ID)
         VALUES (${prog.cante_id}, 'Automático', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP + (${prog.progr_dr} || ' minutes')::INTERVAL, ${Math.round(aguaUsada * 100) / 100}, ${prog.progr_id})
      `;
      console.log(`${ts()} 💧 Riego automático ejecutado: Cantero ${prog.cante_id} (${prog.progr_dr} min)`);
    }
  } catch (error: any) {
    console.error(`${ts()} Error verificando programas de riego:`, error.message);
  }
}
