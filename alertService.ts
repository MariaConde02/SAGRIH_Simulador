/**
 * alerts.ts — Verificación de umbrales y alertas automáticas, además de ejecución de riegos.
 * Implementa M2.4: alertas automáticas de tanque (media/crítica) y humedad.
 */
import { prisma, cargarCache } from './db.config.js';

function ts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', 
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(new Date());
  return `[${f.replace(', ', ' ')}]`;
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

    const ahora = new Date();
    const formatterHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hour12: false });
    let horaActual = formatterHour.format(ahora);
    if (horaActual.startsWith('24')) horaActual = horaActual.replace('24', '00');

    const formatterDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Caracas', weekday: 'short' });
    const dayName = formatterDay.format(ahora);
    const dayMap: Record<string, number> = { 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6, 'Sun': 7 };
    const diaBD = dayMap[dayName] || 7;

    const programas = await prisma.$queryRaw<any[]>`
      SELECT p.PROGR_ID, p.CANTE_ID, p.PROGR_HI, p.PROGR_DR
       FROM TT_PROGR p
       JOIN TT_PROGD d ON d.PROGR_ID = p.PROGR_ID
       WHERE d.PROGD_DA = ${diaBD}
         AND p.PROGR_HI::time <= ${horaActual}::time
         AND p.PROGR_HI::time > (${horaActual}::time - INTERVAL '35 seconds')
         AND p.PROGR_AT = TRUE
    `;

    for (const prog of programas) {
      const yaEjecutado = await prisma.$queryRaw<any[]>`
        SELECT 1 FROM TH_RIHRI
         WHERE CANTE_ID = ${prog.cante_id} AND PROGR_ID = ${prog.progr_id}
           AND RIHRI_FI > CURRENT_TIMESTAMP - INTERVAL '2 minutes'
      `;
      if (yaEjecutado.length > 0) continue;

      // Pre-Check Agronómico
      const sensorHum = await prisma.tt_dispo.findFirst({
        where: { cante_id: prog.cante_id, tm_tipod: { tipod_nm: 'Sensor Humedad' } },
        include: { tt_lectu: { orderBy: { lectu_fh: 'desc' }, take: 1 } }
      });
      
      let cancelado = false;
      if (sensorHum && sensorHum.tt_lectu.length > 0) {
        const humedadActual = Number(sensorHum.tt_lectu[0].lectu_vl);
        
        const canteroInfo = await prisma.tm_cante.findUnique({
          where: { cante_id: prog.cante_id },
          select: { cante_ma: true, tm_culti: { select: { culti_ma: true } } }
        });
        
        const umbralMaximo = canteroInfo?.cante_ma ?? canteroInfo?.tm_culti?.culti_ma ?? 80;
        
        if (humedadActual >= Number(umbralMaximo)) {
          console.log(`${ts()} 🛑 Riego automático CANCELADO en ${prog.cante_id}: Humedad actual (${humedadActual}%) >= Umbral Máximo (${umbralMaximo}%)`);
          const tipalInfo = await prisma.tm_tipal.findFirst({ where: { tipal_nm: 'alta' } });
          await prisma.tt_alert.create({
            data: {
              dispo_id: sensorHum.dispo_id,
              tipal_id: tipalInfo?.tipal_id || 1,
              alert_ti: `Riego programado omitido preventivamente. Humedad óptima alcanzada (${humedadActual}% >= ${umbralMaximo}%)`
            }
          });
          cancelado = true;
        }
      }
      
      if (cancelado) continue;

      const caudal    = parseFloat(params.RIEGO_CAUDAL_NOMINAL || '1.2');
      const aguaUsada = caudal * prog.progr_dr;

      await prisma.$queryRaw`
        INSERT INTO TH_RIHRI (CANTE_ID, RIHRI_TA, RIHRI_FI, RIHRI_FF, RIHRI_VL, PROGR_ID)
         VALUES (${prog.cante_id}, 'Automático', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP + (${prog.progr_dr} || ' minutes')::INTERVAL, ${Math.round(aguaUsada * 100) / 100}, ${prog.progr_id})
      `;
      
      const valvula = await prisma.tt_dispo.findFirst({
        where: { 
          cante_id: prog.cante_id, 
          tm_tipod: { tipod_nm: { contains: 'lvula' } } 
        }
      });
      if (valvula) {
        await prisma.tt_dispo.update({
          where: { dispo_id: valvula.dispo_id },
          data: { dispo_et: 'Abierta' }
        });
      }
      
      // Resolver alertas de humedad baja si las hay
      const dispositivosCantero = await prisma.tt_dispo.findMany({
        where: { cante_id: prog.cante_id },
        select: { dispo_id: true }
      });
      
      if (dispositivosCantero.length > 0) {
        const ids = dispositivosCantero.map(d => d.dispo_id);
        await prisma.tt_alert.updateMany({
          where: {
            dispo_id: { in: ids },
            alert_ea: 'activa',
            alert_ti: { contains: 'Humedad baja' }
          },
          data: { alert_ea: 'resuelta' }
        });
      }
      
      console.log(`${ts()} 💧 Riego automático ejecutado: Cantero ${prog.cante_id} (${prog.progr_dr} min)`);
    }
  } catch (error: any) {
    console.error(`${ts()} Error verificando programas de riego:`, error.message);
  }
}

export async function verificarValvulasAbiertas() {
  try {
    // Bug fix: Delegar la validación de tiempo a PostgreSQL para evitar discrepancias de Zona Horaria y UTC en JS
    // Usamos LIMIT 1 para verificar únicamente el último riego registrado (evitar flapping por riegos viejos)
    const vencidas = await prisma.$queryRaw<any[]>`
      SELECT d.DISPO_ID as dispo_id, d.CANTE_ID as cante_id
      FROM TT_DISPO d
      JOIN tm_tipod td ON d.TIPOD_ID = td.TIPOD_ID
      WHERE d.DISPO_ET = 'Abierta' AND td.TIPOD_NM LIKE '%lvula%'
        AND (
          SELECT r.RIHRI_FF FROM TH_RIHRI r 
          WHERE r.CANTE_ID = d.CANTE_ID 
          ORDER BY r.RIHRI_FI DESC 
          LIMIT 1
        ) <= CURRENT_TIMESTAMP
    `;
    
    for (const v of vencidas) {
      await prisma.tt_dispo.update({
        where: { dispo_id: v.dispo_id },
        data: { dispo_et: 'Operativo' }
      });
      console.log(`${ts()} 🛑 Válvula cerrada (Timeout persistente superado): Cantero ${v.cante_id}`);
      
      const riegoActivo = await prisma.th_rihri.findFirst({
        where: { cante_id: v.cante_id },
        orderBy: { rihri_fi: 'desc' }
      });
      
      if (riegoActivo) {
        // En NodeJS ESM necesitamos usar la importación dinámica o estática arriba.
        // Asumiendo que podemos usar import estático de sensorGenerator.ts, pero 
        // para evitar dependencias circulares (index importa ambos), 
        // importamos el helper dinámicamente o asumiendo import global.
        const { deducirAguaTanque } = await import('./sensorGenerator.js');
        const { params } = await import('./db.config.js');
        
        const ahoraMs = Date.now();
        // El consumo de agua ahora se registra en tiempo real (flujo continuo)
        // por lo que ya no hacemos overwrite de rihri_vl ni deducimos del tanque aquí.
        // Solo verificamos que el riego esté finalizado correctamente si no lo estaba.
        /*
        const inicioMs = riegoActivo.rihri_fi.getTime();
        const finalMs = riegoActivo.rihri_ff.getTime();
        
        const minutosReales = Math.max(0, (finalMs - inicioMs) / 60000);
        const caudal = parseFloat(params.RIEGO_CAUDAL_NOMINAL || '2.0');
        const aguaUsada = minutosReales * caudal;
        
        await prisma.th_rihri.update({
          where: { rihri_id: riegoActivo.rihri_id },
          data: { rihri_vl: Math.round(aguaUsada * 100) / 100 }
        });
        
        await deducirAguaTanque(aguaUsada);
        */
      }
    }
  } catch (error: any) {
    console.error(`${ts()} Error verificando válvulas abiertas:`, error.message);
  }
}
