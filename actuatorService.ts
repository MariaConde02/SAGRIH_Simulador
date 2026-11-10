/**
 * actuatorService.ts — Control de actuadores (Ventilador VENT-01 / Luces LUZ-01).
 * Modo auto: umbrales de temperatura del DHT22 con histéresis (ON/OFF).
 * Modo manual: el override lo escribe el backend desde el Dashboard.
 * El estado se consulta fresco en cada ciclo (NO usa el cache de 60s).
 */
import { prisma } from './db.config.js';

export type EstadoActuadores = {
  vent: boolean;
  luz: boolean;
  modoVent: string;
  modoLuz: string;
};

let ultimoEstado: EstadoActuadores = { vent: false, luz: false, modoVent: 'auto', modoLuz: 'auto' };

export function getActuadores(): EstadoActuadores {
  return ultimoEstado;
}

const CLAVES = [
  'VENT_MODO', 'VENT_ESTADO', 'VENT_TEMP_ON', 'VENT_TEMP_OFF',
  'LUZ_MODO', 'LUZ_ESTADO', 'LUZ_TEMP_ON', 'LUZ_TEMP_OFF',
];

async function cargarParametros(): Promise<Record<string, string>> {
  const filas = await prisma.tp_param.findMany({ where: { param_cl: { in: CLAVES } } });
  const mapa: Record<string, string> = {};
  for (const f of filas) mapa[f.param_cl] = f.param_vl;
  return mapa;
}

async function temperaturaAmbiente(): Promise<number | null> {
  const filas: { lectu_vl: unknown }[] = await prisma.$queryRaw`
    SELECT l.lectu_vl
    FROM tt_lectu l
    JOIN tt_dispo d ON d.dispo_id = l.dispo_id
    JOIN tm_tipod t ON t.tipod_id = d.tipod_id
    JOIN tm_unidm u ON u.unidm_id = l.unidm_id
    WHERE t.tipod_nm = 'Sensor Ambiente'
      AND u.unidm_ab = '°C'
    ORDER BY l.lectu_fh DESC
    LIMIT 1`;
  if (filas.length === 0) return null;
  const v = Number(filas[0].lectu_vl);
  return Number.isFinite(v) ? v : null;
}

async function persistirEstado(prefijo: string, encendido: boolean) {
  await prisma.tp_param.upsert({
    where: { param_cl: `${prefijo}_ESTADO` },
    update: { param_vl: encendido ? 'on' : 'off', param_um: new Date() },
    create: { param_cl: `${prefijo}_ESTADO`, param_vl: encendido ? 'on' : 'off', param_ds: `Estado actual ${prefijo} (on|off)` },
  });
}

function evaluar(
  prefijo: 'VENT' | 'LUZ',
  params: Record<string, string>,
  temp: number | null,
): { modo: string; encendido: boolean } {
  const modo = (params[`${prefijo}_MODO`] || 'auto').toLowerCase();
  let encendido = (params[`${prefijo}_ESTADO`] || 'off').toLowerCase() === 'on';
  const defaultOn = prefijo === 'VENT' ? 28 : 18;
  const defaultOff = prefijo === 'VENT' ? 26 : 20;
  const umbralOn = parseFloat(params[`${prefijo}_TEMP_ON`] || String(defaultOn));
  const umbralOff = parseFloat(params[`${prefijo}_TEMP_OFF`] || String(defaultOff));

  if (modo === 'auto' && temp != null) {
    if (prefijo === 'VENT') {
      if (temp >= umbralOn) encendido = true;
      else if (temp <= umbralOff) encendido = false;
    } else {
      // Luces: calefacción por frío — enciende bajo la mínima, apaga sobre la máxima
      if (temp <= umbralOn) encendido = true;
      else if (temp >= umbralOff) encendido = false;
    }
  }
  return { modo, encendido };
}

export async function evaluarActuadores(): Promise<EstadoActuadores> {
  try {
    const [params, temp] = await Promise.all([cargarParametros(), temperaturaAmbiente()]);

    const v = evaluar('VENT', params, temp);
    const l = evaluar('LUZ', params, temp);

    const estadoAnterior = ultimoEstado;
    if (v.modo === 'auto' && (params.VENT_ESTADO || 'off') !== (v.encendido ? 'on' : 'off')) {
      await persistirEstado('VENT', v.encendido);
    }
    if (l.modo === 'auto' && (params.LUZ_ESTADO || 'off') !== (l.encendido ? 'on' : 'off')) {
      await persistirEstado('LUZ', l.encendido);
    }

    ultimoEstado = { vent: v.encendido, luz: l.encendido, modoVent: v.modo, modoLuz: l.modo };

    const cambio = v.encendido !== estadoAnterior.vent || l.encendido !== estadoAnterior.luz;
    const icono = v.encendido ? '🌀' : '💤';
    const iconoLuz = l.encendido ? '💡' : '🌑';
    const tempStr = temp != null ? `${temp.toFixed(1)}°C` : '—°C';
    console.log(
      `[SIM][ACTUADOR] ${icono} VENT-01: ${v.encendido ? 'ENCENDIDO' : 'APAGADO'} (${v.modo.toUpperCase()}) · ` +
      `${iconoLuz} LUZ-01: ${l.encendido ? 'ENCENDIDO' : 'APAGADO'} (${l.modo.toUpperCase()}) · DHT22: ${tempStr}` +
      `${cambio ? '  ← cambio de estado' : ''}`,
    );
  } catch (err: any) {
    console.error('[SIM][ACTUADOR] Error evaluando actuadores:', err.message);
  }
  return ultimoEstado;
}
