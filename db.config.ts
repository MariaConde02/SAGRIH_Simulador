/**
 * db.config.ts — Conexión a PostgreSQL (via Prisma) y cache de sensores/unidades/parámetros.
 */
import { prisma } from './db/prismaClient.js';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../backend/.env') });

export { prisma };

// ─── Cache con TTL de 60 segundos ─────────────────────────────────────────────
let cacheSensores: any = null;
let cacheUnidades: any = null;
let cacheParams: any   = null;
let ultimaCarga   = 0;
export const CACHE_TTL = 60_000;

export function invalidarCache() {
  ultimaCarga = 0;
}

export async function cargarCache() {
  const ahora = Date.now();
  if (cacheSensores && (ahora - ultimaCarga) < CACHE_TTL) {
    return { sensores: cacheSensores, unidades: cacheUnidades, params: cacheParams };
  }

  const resDisp = await prisma.$queryRaw<any[]>`
    SELECT d.DISPO_ID, d.DISPO_TG, d.TIPOD_ID, t.TIPOD_NM, d.CANTE_ID, d.INVER_ID, d.DISPO_ET
     FROM TT_DISPO d
     JOIN TM_TIPOD t ON t.TIPOD_ID = d.TIPOD_ID
     WHERE d.DISPO_ET = 'Operativo'
     ORDER BY d.DISPO_ID
  `;

  const resUnid = await prisma.tm_unidm.findMany();

  const resParam = await prisma.tp_param.findMany({
    where: {
      param_cl: {
        in: [
         'HUMEDAD_MIN_CRITICO', 'HUMEDAD_OPTIMO_INFERIOR', 'HUMEDAD_OPTIMO_SUPERIOR',
         'TANQUE_CAPACIDAD', 'TANQUE_ALERTA_BAJA', 'TANQUE_ALERTA_CRITICA',
         'RIEGO_CAUDAL_NOMINAL', 'BOMBA_ACTIVA'
        ]
      }
    }
  });

  cacheSensores = resDisp;

  cacheUnidades = {};
  for (const u of resUnid) {
    cacheUnidades[u.unidm_ab] = u.unidm_id;
    cacheUnidades[u.unidm_nm] = u.unidm_id;
  }

  cacheParams = {};
  for (const p of resParam) cacheParams[p.param_cl] = p.param_vl;

  ultimaCarga = ahora;
  return { sensores: cacheSensores, unidades: cacheUnidades, params: cacheParams };
}
