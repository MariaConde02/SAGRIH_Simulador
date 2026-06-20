/**
 * sensors.ts — Generación de lecturas IoT realistas por tipo de sensor.
 * Implementa M2.3: rangos correctos, deriva gradual (evapotranspiración).
 */
import { prisma, cargarCache } from './db.config.js';

// ─── Tipos que no generan lecturas propias ────────────────────────────────────
const TIPOS_IGNORADOS = new Set(['Controlador', 'Válvula', 'Actuador', 'Bomba']);

// ─── Estado en memoria por dispositivo ───────────────────────────────────────
const estado: any = {};

function getEstado(id: number, campo: string, valorDefault: number) {
  if (!estado[id]) estado[id] = {};
  if (estado[id][campo] === undefined) estado[id][campo] = valorDefault;
  return estado[id][campo];
}

function setEstado(id: number, campo: string, valor: number) {
  if (!estado[id]) estado[id] = {};
  estado[id][campo] = valor;
}

// ─── Matemáticas ──────────────────────────────────────────────────────────────
function gaussiana(media: number, sigma: number) {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return media + sigma * z;
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

function redondear(val: number) {
  return Math.round(val * 100) / 100;
}

// ─── Generación principal ─────────────────────────────────────────────────────
export async function generarLecturas() {
  const { sensores, unidades, params } = await cargarCache();

  if (sensores.length === 0) return 0;

  const capacidadTanque = parseFloat(params.TANQUE_CAPACIDAD || '10000');
  let insertados = 0;

  for (const sensor of sensores) {
    if (TIPOS_IGNORADOS.has(sensor.tipod_nm)) continue;

    const tipo = sensor.tipod_nm;
    const id   = sensor.dispo_id;

    try {
      // ── Sensor Humedad de Suelo ────────────────────────────────────────────
      if (tipo === 'Sensor Humedad') {
        const base  = getEstado(id, 'humedad', 55 + Math.random() * 15);
        // Evapotranspiración gradual: baja -0.3 a -0.8 por ciclo (M2.3)
        const drift = -(0.3 + Math.random() * 0.5);
        const valor = clamp(gaussiana(base + drift, 1.5), 20, 80);
        setEstado(id, 'humedad', valor);

        const uid = unidades['%'] || unidades['Porcentaje'];
        await prisma.tt_lectu.create({
          data: { dispo_id: id, lectu_vl: redondear(valor), unidm_id: uid }
        });
        insertados++;

      // ── Sensor Ambiente: temperatura + humedad ambiente ───────────────────
      } else if (tipo === 'Sensor Ambiente') {
        // Temperatura: 18°C – 35°C (M2.3)
        const baseT = getEstado(id, 'temperatura', 24 + Math.random() * 4);
        const temp  = clamp(gaussiana(baseT, 1.2), 18, 35);
        setEstado(id, 'temperatura', temp);

        const uidC = unidades['°C'] || unidades['Grados Celsius'];
        await prisma.tt_lectu.create({
          data: { dispo_id: id, lectu_vl: redondear(temp), unidm_id: uidC }
        });

        // Humedad ambiente: 40% – 90% (M2.3)
        const baseH = getEstado(id, 'humAire', 62 + Math.random() * 8);
        const humA  = clamp(gaussiana(baseH, 2), 40, 90);
        setEstado(id, 'humAire', humA);

        const uidPct = unidades['%'] || unidades['Porcentaje'];
        await prisma.tt_lectu.create({
          data: { dispo_id: id, lectu_vl: redondear(humA), unidm_id: uidPct }
        });
        insertados += 2;

      // ── Sensor Nivel de Tanque ─────────────────────────────────────────────
      // Baja gradualmente por consumo; piso = 5% de capacidad (M2.3)
      } else if (tipo === 'Sensor Nivel Tanque') {
        const pisoL  = capacidadTanque * 0.05;
        const baseN  = getEstado(id, 'nivel', capacidadTanque * 0.75);
        const consumo = 50 + Math.random() * 100; // 50-150 L por ciclo
        const nivel  = clamp(gaussiana(baseN - consumo, 20), pisoL, capacidadTanque);
        setEstado(id, 'nivel', nivel);

        const uidL = unidades['L'] || unidades['Litros'];
        await prisma.tt_lectu.create({
          data: { dispo_id: id, lectu_vl: redondear(nivel), unidm_id: uidL }
        });
        insertados++;

      // ── Sensor CO2 ────────────────────────────────────────────────────────
      } else if (tipo === 'Sensor CO2') {
        const base  = getEstado(id, 'co2', 380 + Math.random() * 40);
        const valor = clamp(gaussiana(base, 15), 300, 1500);
        setEstado(id, 'co2', valor);
        const uid = unidades['ppm'] || unidades['PPM'];
        await prisma.tt_lectu.create({
          data: { dispo_id: id, lectu_vl: redondear(valor), unidm_id: uid }
        });
        insertados++;

      // ── Sensor pH ─────────────────────────────────────────────────────────
      } else if (tipo === 'Sensor pH') {
        const base  = getEstado(id, 'ph', 6.8 + Math.random() * 0.4);
        const valor = clamp(gaussiana(base, 0.1), 5.5, 8.5);
        setEstado(id, 'ph', valor);
        const uid = unidades['uds'] || unidades['Unidades'];
        await prisma.tt_lectu.create({
          data: { dispo_id: id, lectu_vl: redondear(valor), unidm_id: uid }
        });
        insertados++;
      }
    } catch (err: any) {
      console.error(`[sensors] Error en ${id}:`, err.message);
    }
  }

  return insertados;
}

export { TIPOS_IGNORADOS };
