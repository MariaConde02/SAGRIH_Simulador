/**
 * sensors.ts — Generación de lecturas IoT realistas por tipo de sensor.
 * Implementa M2.3: rangos correctos, deriva gradual (evapotranspiración).
 */
import { prisma, cargarCache } from './db.config.js';
import { SensorService } from './sensorService.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Tipos que no generan lecturas propias ────────────────────────────────────
const TIPOS_IGNORADOS = new Set(['Controlador', 'Válvula', 'Actuador', 'Bomba']);

// ─── Estado en memoria por dispositivo ───────────────────────────────────────
const estado: any = {};

function getEstado(id: string, campo: string, valorDefault: number) {
  if (!estado[id]) estado[id] = {};
  if (estado[id][campo] === undefined) estado[id][campo] = valorDefault;
  return estado[id][campo];
}

function setEstado(id: string, campo: string, valor: number) {
  if (!estado[id]) estado[id] = {};
  estado[id][campo] = valor;
}

export function forzarHumedad(id: string, delta: number) {
  if (estado[id] && estado[id]['humedad'] !== undefined) {
    estado[id]['humedad'] = clamp(estado[id]['humedad'] + delta, 0, 100);
  }
}

import { prisma } from './db.config.js';

async function initEstado(id: string, campo: string, valorDefault: number) {
  if (!estado[id]) estado[id] = {};
  if (estado[id][campo] === undefined) {
    const ultima = await prisma.tt_lectu.findFirst({
      where: { dispo_id: id },
      orderBy: { lectu_fh: 'desc' }
    });
    estado[id][campo] = ultima && ultima.lectu_vl != null ? Number(ultima.lectu_vl) : valorDefault;
    estado[id][`${campo}_db`] = estado[id][campo];
  }
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

// ─── Funciones Auxiliares ─────────────────────────────────────────────────────
export async function deducirAguaTanque(aguaUsada: number) {
  if (aguaUsada <= 0) return;
  // Buscar un tanque por su nombre exacto
  const tanque = await prisma.tt_dispo.findFirst({
    where: { tm_tipod: { tipod_nm: 'Sensor Nivel Tanque' } }
  });
  if (!tanque) {
    console.error('[SIMULADOR] ERROR CRÍTICO: No se encontró dispositivo con tipod_nm "Sensor Nivel Tanque"');
    return;
  }

  const idTanque = tanque.dispo_id;
  await initEstado(idTanque, 'nivel', 5000 * 0.75);
  
  const nivelActual = getEstado(idTanque, 'nivel', 5000 * 0.75);
  const nuevoNivel = Math.max(0, nivelActual - aguaUsada);
  
  setEstado(idTanque, 'nivel', nuevoNivel);
  
  const uidL = 2; // Unidad genérica para Litros, en caso de fallar el caché
  await prisma.tt_lectu.create({
    data: {
      dispo_id: idTanque,
      lectu_fh: new Date(),
      lectu_vl: Math.round(nuevoNivel * 100) / 100,
      unidm_id: uidL
    }
  });
  console.log(`[sensors] 🚰 Consumo real: ${Math.round(aguaUsada*10)/10}L deducidos del tanque ${idTanque}`);
}

function redondear(val: number) {
  return Math.round(val * 100) / 100;
}

async function registrarLectura(id: string, campo: string, valor: number, uid: number, delta: number = 2) {
  const valRedondeado = redondear(valor);
  const lastVal = getEstado(id, `${campo}_db`, -999);
  
  // Validar Delta (Report by Exception)
  if (Math.abs(valRedondeado - lastVal) >= delta || lastVal === -999) {
    await prisma.tt_lectu.create({
      data: { dispo_id: id, lectu_vl: valRedondeado, unidm_id: uid }
    });
    setEstado(id, `${campo}_db`, valRedondeado);
    return true;
  }
  return false;
}

// ─── Generación principal ─────────────────────────────────────────────────────
export async function generarLecturas() {
  const { sensores, unidades, params } = await cargarCache();

  if (sensores.length === 0) return 0;

  const capacidadTanque = parseFloat(params.TANQUE_CAPACIDAD || '10000');
  let insertados = 0;
  let ignorados = 0;

  // Fase 0: Timeout Enforcer (Misión Crítica) y Race Condition Cleanup
  const canterosUnicos = [...new Set(sensores.filter((s: any) => s.cante_id).map((s: any) => s.cante_id))];
  
  for (const cante_id of canterosUnicos) {
    const riegosActivos = await prisma.th_rihri.findMany({
      where: { cante_id: String(cante_id), rihri_ff: null },
      orderBy: { rihri_fi: 'desc' }
    });

    if (riegosActivos.length > 0) {
      // 1. Limpiar basuras/huérfanos (Asegurar que solo exista 1 activo)
      if (riegosActivos.length > 1) {
        for (let i = 1; i < riegosActivos.length; i++) {
          await prisma.th_rihri.update({
            where: { rihri_id: riegosActivos[i].rihri_id },
            data: { rihri_ff: new Date() } 
          });
          console.warn(`[SIMULADOR] Limpiado registro huérfano de riego para cantero ${cante_id}`);
        }
      }

      // 2. Timeout Enforcer para Riego Manual (Parametrizado)
      const riegoPrincipal = riegosActivos[0];
      const minutosAbierto = (Date.now() - riegoPrincipal.rihri_fi.getTime()) / 60000;
      const timeoutParam = parseFloat(params.TIEMPO_MAX_MANUAL || '15');
      
      if (minutosAbierto >= timeoutParam && riegoPrincipal.rihri_ta === 'Manual') {
        await prisma.th_rihri.update({
          where: { rihri_id: riegoPrincipal.rihri_id },
          data: { rihri_ff: new Date() }
        });
        
        const valvula = sensores.find((s: any) => s.cante_id === cante_id && s.tipod_nm === 'Válvula');
        if (valvula) {
          await prisma.tt_dispo.update({
            where: { dispo_id: valvula.dispo_id },
            data: { dispo_et: 'Operativo' }
          });
          valvula.dispo_et = 'Operativo'; // Sync estado en memoria
          await SensorService.dispararAlerta(valvula.dispo_id, 'alta', `Cierre forzoso de válvula manual en Cantero ${cante_id} por Timeout (>15 min). Posible pérdida de conexión del cliente.`);
        }
        console.log(`[SIMULADOR] 🚨 TIMEOUT ENFORCER: Válvula de cantero ${cante_id} cerrada a la fuerza.`);
      }
    } else {
      // 3. Asesino de Válvulas Huérfanas / Fantasma
      // Si NO hay registro transaccional de riego activo, la válvula física DEBE estar cerrada.
      const valvula = sensores.find((s: any) => s.cante_id === cante_id && s.tipod_nm === 'Válvula');
      if (valvula && valvula.dispo_et === 'Abierta') {
        await prisma.tt_dispo.update({
          where: { dispo_id: valvula.dispo_id },
          data: { dispo_et: 'Operativo' }
        });
        valvula.dispo_et = 'Operativo'; // Sincronizar caché en memoria
        console.warn(`[SIMULADOR] 🚨 INCONSISTENCIA DETECTADA: Válvula de cantero ${cante_id} atascada en estado 'Abierta' sin transacción en TH_RIHRI. CIERRE FORZOSO EJECUTADO.`);
      }
    }

    // 4. Inactive Greenhouse Enforcer
    // Si el invernadero del cantero está inactivo, cerrar la válvula a la fuerza si está abierta.
    const canteroSensor = sensores.find((s: any) => s.cante_id === cante_id);
    if (canteroSensor && canteroSensor.inver_est === 'inactivo') {
      const valvula = sensores.find((s: any) => s.cante_id === cante_id && s.tipod_nm === 'Válvula');
      if (valvula && valvula.dispo_et === 'Abierta') {
        await prisma.tt_dispo.update({
          where: { dispo_id: valvula.dispo_id },
          data: { dispo_et: 'Operativo' }
        });
        valvula.dispo_et = 'Operativo';
        console.warn(`[SIMULADOR] 🛑 SEGURIDAD: Invernadero inactivo. Válvula de cantero ${cante_id} CERRADA A LA FUERZA.`);
        
        // Also finalize active irrigation if any
        if (riegosActivos.length > 0) {
           await prisma.th_rihri.update({
             where: { rihri_id: riegosActivos[0].rihri_id },
             data: { rihri_ff: new Date() }
           });
        }
      }
    }
  }

  // Fase 0.5: Global Pause (TT_ESTOP) Validator
  const pausaGlobal = await prisma.tt_estop.findFirst({
    where: {
      estop_av: true,
      estop_fn: { gt: new Date() }
    }
  });

  if (pausaGlobal) {
    console.log(`[SIMULADOR] 🛑 PAUSA GLOBAL ACTIVA: Abortando operaciones de riego automático y de emergencia.`);
    // Opcional: Cerrar válvulas abiertas (seguridad)
  }

  // Fase 2: Consumo Continuo por Válvulas Abiertas (Calculado en cada ciclo de 15s)
  const valvulasAbiertas = sensores.filter((s: any) => s.tipod_nm === 'Válvula' && s.dispo_et === 'Abierta');
  if (valvulasAbiertas.length > 0) {
    const caudalNominal = parseFloat(params.RIEGO_CAUDAL_NOMINAL || '3.33');
    const consumoPorValvula = (caudalNominal / 60) * 15; // L gastados en 15 segundos
    let consumoTotalCiclo = 0;

    for (const v of valvulasAbiertas) {
      if (v.cante_id) {
        consumoTotalCiclo += consumoPorValvula;
        // Sumar al riego activo de forma blindada (sólo al registro único validado)
        await prisma.$executeRaw`
          UPDATE th_rihri 
          SET rihri_vl = COALESCE(rihri_vl, 0) + ${consumoPorValvula} 
          WHERE rihri_id = (SELECT rihri_id FROM th_rihri WHERE cante_id = ${v.cante_id} AND rihri_ff IS NULL ORDER BY rihri_fi DESC LIMIT 1)
        `;
      }
    }
    // Deducir el total del ciclo del tanque
    if (consumoTotalCiclo > 0) {
      await deducirAguaTanque(consumoTotalCiclo);
    }
  }

  for (const sensor of sensores) {
    if (TIPOS_IGNORADOS.has(sensor.tipod_nm)) continue;
    if (sensor.inver_est === 'inactivo') {
      ignorados++;
      continue;
    }

    const tipo = sensor.tipod_nm;
    const id   = sensor.dispo_id;

    try {
      // ── Sensor Humedad de Suelo ────────────────────────────────────────────
      if (tipo === 'Sensor Humedad') {
        await initEstado(id, 'humedad', 55 + Math.random() * 15);
        const base  = getEstado(id, 'humedad', 55);
        let valor = base;

        // Física del Simulador: Verificar estado de la válvula en el mismo cantero
        let valvulaAbierta = false;
        let valvulaCerrada = false;
        let valvulaId = null;

        if (sensor.cante_id) {
          const valvula = sensores.find((s: any) => s.cante_id === sensor.cante_id && s.tipod_nm === 'Válvula');
          if (valvula) {
            valvulaId = valvula.dispo_id;
            if (valvula.dispo_et === 'Abierta') {
              valvulaAbierta = true;
            } else if (valvula.dispo_et === 'Operativo') {
              valvulaCerrada = true;
            }
          }
        }

        const maximoOptimo = sensor.umbral_maximo ? Number(sensor.umbral_maximo) : 80;

        // 1. Lógica Probabilística de Evaporación y Riego
        let ciclosEspera = getEstado(id, 'ciclos_espera', 0);
        let humedadTemporal = base;
        let delta = 0;

        // 0. IPC de Estrés Hídrico vía Base de Datos (TT_SIMET)
        let estresAplicado = false;
        if (sensor.cante_id) {
          const eventoEstres = await prisma.tt_simet.findFirst({
            where: { cante_id: sensor.cante_id, simet_ev: 'ESTRES_HIDRICO' }
          });
          
          if (eventoEstres) {
            const decrementar = parseFloat(eventoEstres.simet_vl);
            const viejo = humedadTemporal;
            humedadTemporal = clamp(humedadTemporal - decrementar, 0, 100);
            delta = humedadTemporal - viejo;
            estresAplicado = true;
            console.log(`[SIM][${sensor.cante_id}] EVENTO: Estrés Hídrico aplicado (vía TT_SIMET). Humedad: ${viejo.toFixed(2)}% -> ${humedadTemporal.toFixed(2)}%`);
            
            await prisma.tt_simet.delete({ where: { simet_id: eventoEstres.simet_id } });
          }
        }

        if (!estresAplicado) {
          if (valvulaAbierta) {
          // Si riega, resetea el contador para que al cerrar inicie estable
          ciclosEspera = Math.floor(Math.random() * 4) + 2; // 2 a 5 ciclos
          setEstado(id, 'ciclos_espera', ciclosEspera);

          const riegoBoost = 0.6 + Math.random() * 0.3; // +0.6% a +0.9%
          delta = riegoBoost;
          humedadTemporal += delta;
          valor = clamp(humedadTemporal, 0, 100);
        } else {
          // Válvula cerrada: evaluar evaporación
          if (ciclosEspera <= 0) {
            const evaporacionDrift = -(0.2 + Math.random() * 0.2); // -0.2% a -0.4%
            delta = evaporacionDrift;
            humedadTemporal += delta;
            
            // Reiniciar contador aleatorio
            ciclosEspera = Math.floor(Math.random() * 4) + 2; // 2 a 5 ciclos
            setEstado(id, 'ciclos_espera', ciclosEspera);
            
            valor = clamp(humedadTemporal, 0, 100);
          } else {
            ciclosEspera--;
            setEstado(id, 'ciclos_espera', ciclosEspera);
            delta = 0;
            valor = clamp(humedadTemporal, 0, 100);
          }
        }
        } // <- Cierre de if (!estresAplicado)
        
        if (estresAplicado) {
           valor = humedadTemporal;
        }

        // 2. Logs de Auditoría Visual en Terminal
        if (sensor.cante_id) {
          const sign = delta > 0 ? '+' : '';
          console.log(`[SIM][${sensor.cante_id}] Válvula: ${valvulaAbierta ? 'ABIERTA' : 'CERRADA'} | Humedad Prev: ${base.toFixed(2)}% | Δ: [${sign}${delta.toFixed(3)}%] | Humedad Final: ${valor.toFixed(2)}% | Ciclos prox: ${ciclosEspera}`);

          // 3. Verificación Estricta de Riego Fantasma
          if (!valvulaAbierta && valor > base) {
            console.log(`[ERROR_FISICO][${sensor.cante_id}] Incoherencia: Humedad subiendo con válvula CERRADA.`);
            if (valvulaId) {
              const lastGhost = getEstado(id, 'last_ghost_alert', 0);
              if (Date.now() - lastGhost > 5 * 60000) {
                await SensorService.dispararAlerta(valvulaId, 'alta', `Incoherencia física: La humedad del cantero ${sensor.cante_id} está subiendo sin flujo de agua activo. Posible fuga o válvula atascada.`);
                setEstado(id, 'last_ghost_alert', Date.now());
              }
            }
          }
        }

        // --- Efectos Secundarios: Cortes Inteligentes y Alertas ---
        if (valvulaAbierta) {
          // 2. Corte Inteligente por Límite Agronómico (Ahorro de Agua)
          if (valor >= maximoOptimo && valvulaId) {
            // Cerrar físicamente la válvula
            await prisma.tt_dispo.update({
              where: { dispo_id: valvulaId },
              data: { dispo_et: 'Operativo' }
            });

            // Cortar riego en historial
            const riegoActivo = await prisma.th_rihri.findFirst({
              where: { cante_id: sensor.cante_id, rihri_ff: { gt: new Date() } },
              orderBy: { rihri_fi: 'desc' }
            });
            let alertMsg = `Riego finalizado anticipadamente en Cantero ${sensor.cante_id}. Se alcanzó la humedad máxima óptima (${maximoOptimo}%). Ahorro hídrico aplicado.`;

            if (riegoActivo) {
              const ahoraMs = Date.now();
              const finalMs = riegoActivo.rihri_ff.getTime();
              const inicioMs = riegoActivo.rihri_fi.getTime();
              
              if (finalMs > ahoraMs) {
                const faltaronMinutos = Math.round((finalMs - ahoraMs) / 60000);
                const totalProgramados = Math.round((finalMs - inicioMs) / 60000);
                alertMsg = `Riego abortado preventivamente en Cantero ${sensor.cante_id}. Se alcanzó la humedad máxima óptima. Faltaron ${faltaronMinutos} minutos de los ${totalProgramados} programados.`;
              }

              await prisma.th_rihri.update({
                where: { rihri_id: riegoActivo.rihri_id },
                data: { rihri_ff: new Date() }
              });
            }

            // Notificación de ahorro hídrico
            const tipal = await prisma.tm_tipal.findFirst({ where: { tipal_nm: 'baja' } });
            await prisma.tt_alert.create({
              data: {
                dispo_id: valvulaId,
                tipal_id: tipal?.tipal_id || 1,
                alert_ti: alertMsg
              }
            });
            console.log(`[SIM][${sensor.cante_id}] ALERTA: Humedad alcanzó umbral máximo (${maximoOptimo}%). Válvula CERRADA por seguridad.`);
            valvulaAbierta = false; // Ya la cerramos
          }
        } else {
          // 4. Auto-Riego de Emergencia (Prevención de Estrés Hídrico)
          
          // Bloquear si hay pausa global
          if (pausaGlobal) {
            setEstado(id, 'humedad', valor);
            continue; // Skip emergency watering logic entirely
          }

          // Candado Agronómico y Aritmético con Fallback Seguro
          const fallbackMinimo = parseFloat(params.HUMEDAD_MIN_CRITICO || '40.0');
          const minimoOptimo = sensor.umbral_minimo != null ? Number(sensor.umbral_minimo) : fallbackMinimo;
          
          // Verificar que haya un cultivo asignado (umbrales válidos), que el valor sea válido y que la válvula no esté ya abierta
          if (minimoOptimo != null && minimoOptimo > 0 && valor > 0 && valvulaCerrada && valvulaId) {
            const umbralCritico = minimoOptimo - 5; // 5% por debajo del mínimo óptimo es crítico

            if (valor <= minimoOptimo) {
              const hayRiego = await SensorService.hayRiegoProximo(sensor.cante_id, 2);

              if (valor <= umbralCritico) {
                if (hayRiego) {
                  // Omitir riego, solo alertar (Ahorro Hídrico y de Energía)
                  const lastAlert = getEstado(id, 'last_crit_alert', 0);
                  if (Date.now() - lastAlert > 10 * 60000) {
                    await SensorService.dispararAlerta(valvulaId, 'media', `Humedad crítica en Cantero ${sensor.cante_id} (${valor.toFixed(1)}%). Omitiendo riego de emergencia porque hay un riego programado en las próximas 2 horas.`);
                    setEstado(id, 'last_crit_alert', Date.now());
                  }
                } else {
                  // Acción de Emergencia: Abrir válvula
                  await prisma.tt_dispo.update({
                    where: { dispo_id: valvulaId },
                    data: { dispo_et: 'Abierta' }
                  });

                  // Registrar en TH_RIHRI por 10 minutos usando el servicio
                  const caudal = parseFloat(params.RIEGO_CAUDAL_NOMINAL || '1.2');
                  await SensorService.registrarRiegoEmergencia(sensor.cante_id, 10, caudal);

                  // Notificación Crítica
                  await SensorService.dispararAlerta(valvulaId, 'alta', `La humedad del Cantero ${sensor.cante_id} bajó a nivel crítico (${valor.toFixed(1)}%). Se inició un riego de emergencia para evitar estrés hídrico.`);
                  console.log(`[sensors] 🚑 Riego de Emergencia iniciado en Cantero ${sensor.cante_id}`);
                  
                  // Simular el empujón inicial de agua en memoria para no ciclar
                  valor = clamp(valor + 5, 0, 100); 
                }
              } else {
                // Entre Crítico y Óptimo: Solo alertar
                const lastAlert = getEstado(id, 'last_warn_alert', 0);
                if (Date.now() - lastAlert > 5 * 60000) {
                  await SensorService.dispararAlerta(valvulaId, 'baja', `Humedad baja en Cantero ${sensor.cante_id} (${valor.toFixed(1)}%). Cercana al umbral crítico.`);
                  setEstado(id, 'last_warn_alert', Date.now());
                }
              }
            }
          }
        }

        setEstado(id, 'humedad', valor);

        const uid = unidades['%'] || unidades['Porcentaje'];
        const guardado = await registrarLectura(id, 'humedad', valor, uid, 0.0); // 0% absoluto de delta para forzar insert
        if (guardado) insertados++; else ignorados++;

      // ── Sensor Ambiente: temperatura + humedad ambiente ───────────────────
      } else if (tipo === 'Sensor Ambiente') {
        // Temperatura: 18°C – 35°C (M2.3)
        const baseT = getEstado(id, 'temperatura', 24 + Math.random() * 4);
        const temp  = clamp(gaussiana(baseT, 1.2), 18, 35);
        setEstado(id, 'temperatura', temp);

        const uidC = unidades['°C'] || unidades['Grados Celsius'];
        const guardadoT = await registrarLectura(id, 'temperatura', temp, uidC, 1.0); // 1°C delta
        if (guardadoT) insertados++; else ignorados++;

        // Humedad ambiente: 40% – 90% (M2.3)
        const baseH = getEstado(id, 'humAire', 62 + Math.random() * 8);
        const humA  = clamp(gaussiana(baseH, 2), 40, 90);
        setEstado(id, 'humAire', humA);

        const uidPct = unidades['%'] || unidades['Porcentaje'];
        const guardadoH = await registrarLectura(id, 'humAire', humA, uidPct, 2.0); // 2% delta
        if (guardadoH) insertados++; else ignorados++;

      // ── Sensor Nivel de Tanque ─────────────────────────────────────────────
      // Sube gradualmente por entrada de agua (naciente por gravedad)
      } else if (tipo === 'Sensor Nivel Tanque') {
        await initEstado(id, 'nivel', capacidadTanque * 0.75);
        
        // Hot-Sync: Consultar TT_LECTU para ver si el Humano interfirió (Prueba de estrés manual)
        const ultimaLecturaReal = await prisma.tt_lectu.findFirst({
          where: { dispo_id: id },
          orderBy: { lectu_fh: 'desc' }
        });

        // Sincronizar solo si la lectura de la base de datos es MÁS RECIENTE que nuestro último ciclo
        // o si es la primera vez
        const lastSyncTime = estado[id]['lastSync'] || 0;
        if (ultimaLecturaReal && ultimaLecturaReal.lectu_fh) {
          const dbTime = ultimaLecturaReal.lectu_fh.getTime();
          if (dbTime > lastSyncTime && ultimaLecturaReal.lectu_vl != null) {
            estado[id]['nivel'] = Number(ultimaLecturaReal.lectu_vl);
            estado[id]['lastSync'] = dbTime;
          }
        }

        const baseN  = getEstado(id, 'nivel', capacidadTanque * 0.75);
        
        // Válvula Flotador (La Naciente)
        let nivel = baseN;
        let insert = false;

        if (baseN < capacidadTanque) {
          const entradaGravedad = 5 + Math.random() * 10; // +5 a +15L por ciclo
          const nivelConAporte = Math.min(capacidadTanque, baseN + entradaGravedad);
          nivel = clamp(gaussiana(nivelConAporte, 0.05), 0, capacidadTanque); // Ruido casi imperceptible
          insert = true; // Si está llenando, forzamos inserción para animar la UI
        }

        setEstado(id, 'nivel', nivel);

        const uidL = unidades['L'] || unidades['Litros'];
        
        // Inserción Continua para el tanque si se está llenando o si cambió drásticamente
        const lastVal = getEstado(id, 'nivel_db', -999);
        if (insert || Math.abs(nivel - lastVal) >= capacidadTanque * 0.01) {
          await prisma.tt_lectu.create({
            data: { dispo_id: id, lectu_vl: redondear(nivel), unidm_id: uidL }
          });
          setEstado(id, 'nivel_db', redondear(nivel));
          estado[id]['lastSync'] = Date.now();
          insertados++;
        } else {
          ignorados++;
        }

      // ── Sensor CO2 ────────────────────────────────────────────────────────
      } else if (tipo === 'Sensor CO2') {
        const base  = getEstado(id, 'co2', 380 + Math.random() * 40);
        const valor = clamp(gaussiana(base, 15), 300, 1500);
        setEstado(id, 'co2', valor);
        
        const uid = unidades['ppm'] || unidades['PPM'];
        const guardado = await registrarLectura(id, 'co2', valor, uid, 10.0); // 10 ppm delta
        if (guardado) insertados++; else ignorados++;

      // ── Sensor pH ─────────────────────────────────────────────────────────
      } else if (tipo === 'Sensor pH') {
        const base  = getEstado(id, 'ph', 6.8 + Math.random() * 0.4);
        const valor = clamp(gaussiana(base, 0.1), 5.5, 8.5);
        setEstado(id, 'ph', valor);
        
        const uid = unidades['uds'] || unidades['Unidades'];
        const guardado = await registrarLectura(id, 'ph', valor, uid, 0.2); // 0.2 delta
        if (guardado) insertados++; else ignorados++;
      }
    } catch (err: any) {
      console.error(`[sensors] Error en ${id}:`, err.message);
    }
  }

  if (insertados > 0) {
    console.log(`[${new Date().toLocaleTimeString('es-VE')}] Delta DB: Insertados: ${insertados} | Ignorados: ${ignorados}`);
  }
  return insertados;
}

export { TIPOS_IGNORADOS };
