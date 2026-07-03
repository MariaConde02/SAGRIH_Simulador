/**
 * index.js — Motor principal del Simulador IoT.
 * Integra la conexión (db.js), generación de lecturas (sensors.js) y alertas (alerts.js).
 */
import { prisma, cargarCache, invalidarCache, CACHE_TTL } from './db.config.js';
import { generarLecturas, TIPOS_IGNORADOS } from './sensorGenerator.js';
import { verificarAlertas, verificarProgramasRiego, verificarValvulasAbiertas } from './alertService.js';

// ─── Intervalos ───────────────────────────────────────────────────────────────
const CICLO_LECTURAS  = 15_000;   // cada 15 segundos
const CICLO_ALERTAS   = 30_000;   // cada 30 segundos
const RETRY_SIN_DATOS = 60_000;   // espera 1 min si no hay dispositivos

function ts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', 
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(new Date());
  return `[${f.replace(', ', ' ')}]`;
}

// ─── Inicializar parámetro de bomba si no existe ─────────────────────────────
async function inicializarParametros() {
  const defaults = [
    ['BOMBA_ACTIVA', 'true', 'Estado de la bomba principal'],
  ];
  for (const [clave, valor, desc] of defaults) {
    await prisma.$executeRaw`
      INSERT INTO TP_PARAM (PARAM_CL, PARAM_VL, PARAM_DS) VALUES (${clave}, ${valor}, ${desc})
      ON CONFLICT (PARAM_CL) DO NOTHING
    `;
  }
}

// ─── Main con espera pasiva si no hay dispositivos ───────────────────────────
async function iniciar() {
  console.log('═'.repeat(55));
  console.log('  SAGRIH — Simulador IoT v2.0 (Refactorizado)');
  console.log('═'.repeat(55));

  // Probar conexión
  try {
    await prisma.$queryRaw`SELECT 1`;
    const { params } = await cargarCache();
    // intervalo = parseInt(params.SIMULADOR_INTERVALO_SEGUNDOS || '30', 10) * 1000;
  } catch (error: any) {
    console.error(`[simulador] Error cargando intervalo, usando 30s:`, error.message);
    process.exit(1);
  }

  await inicializarParametros();

  // M2.1/M2.2: Cargar dispositivos — si no hay, esperar pasivamente
  const { sensores } = await cargarCache();

  if (sensores.length === 0) {
    console.log(`${ts()} ⏳ No hay dispositivos en la BD todavía.`);
    console.log(`${ts()} ⏳ Esperando ${RETRY_SIN_DATOS / 1000}s y volviendo a intentar...`);
    setTimeout(iniciar, RETRY_SIN_DATOS);
    return;
  }

  const sensoresActivos = sensores.filter(
    s => !TIPOS_IGNORADOS.has(s.tipod_nm)
  );

  console.log(`\n${ts()} Dispositivos cargados: ${sensores.length} total, ${sensoresActivos.length} generan lecturas`);
  for (const s of sensoresActivos) {
    console.log(`   ${s.dispo_id.padEnd(20)} ${s.tipod_nm.padEnd(25)} Cantero: ${s.cante_id || '—'}`);
  }

  // Primera generación inmediata
  const insertados = await generarLecturas();
  if (insertados > 0) {
    console.log(`${ts()} Lecturas iniciales insertadas — ${sensoresActivos.length} sensores activos`);
  }
  await verificarAlertas();

  // Ciclos recurrentes
  setInterval(async () => {
    await generarLecturas();
  }, CICLO_LECTURAS);

  setInterval(verificarAlertas,         CICLO_ALERTAS);
  setInterval(verificarProgramasRiego,  CICLO_ALERTAS);
  setInterval(verificarValvulasAbiertas, CICLO_ALERTAS);
  
  // Invalidar cache para releer dispositivos nuevos
  setInterval(invalidarCache, CACHE_TTL);

  console.log(`\n${ts()} Simulador iniciado:`);
  console.log(`   • Lecturas :  cada ${CICLO_LECTURAS / 1000}s`);
  console.log(`   • Alertas  :  cada ${CICLO_ALERTAS / 1000}s`);
  console.log(`   • Ctrl+C para detener\n`);
}

iniciar().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
