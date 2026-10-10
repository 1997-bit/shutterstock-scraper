/**
 * Shutterstock Earnings Exporter
 *
 * Este script lee las ventas diarias de la pagina Earnings.
 * El script baja un archivo CSV por mes.
 * Las columnas del CSV son ID, Fecha, Precio y Licencia.
 *
 * Uso
 * 1. Abre https://submit.shutterstock.com/earnings e inicia sesion.
 * 2. Elige el mes y el año.
 * 3. Espera a que la tabla cargue.
 * 4. Abre la consola con F12.
 * 5. En Firefox, escribe allow pasting y pulsa Enter.
 * 6. Pega este script una sola vez.
 * 7. No cambies de pestaña mientras el script corre.
 *
 * Validacion
 * El script compara cada dia con los valores Daily downloads y Daily earnings del modal.
 * Si los valores no coinciden, el script no guarda ese dia.
 * Para reintentar ese dia, corre el script otra vez.
 *
 * Memoria
 * El script guarda cada dia valido en localStorage.
 * En la siguiente corrida, el script omite esos dias.
 * El script baja el CSV de un mes solo cuando todos los dias del mes estan guardados.
 *
 * Ventas repetidas
 * Un asset puede tener varias ventas el mismo dia.
 * Shutterstock muestra una fila con el total del dia.
 * El script parte ese total en centavos enteros.
 * Ejemplo: 15 centavos en 2 ventas da 8 centavos y 7 centavos.
 * La suma de las partes es siempre igual al total.
 *
 * Proteccion contra bloqueo
 * El script espera entre cada dia.
 * El script se detiene si recibe el codigo HTTP 429, 403 o 503.
 * El script se detiene despues de 3 errores seguidos.
 * Para detener el script a mano, escribe window.__token = null en la consola.
 *
 * Despues de la corrida
 * Para ver las metricas, escribe __M en la consola.
 * Para borrar la memoria, escribe localStorage.removeItem("ss_filas").
 *
 * Aviso
 * Usa este script solo con tu propia cuenta.
 * Lee los terminos de uso de Shutterstock antes de usarlo.
 */
(async () => {
"use strict";

// Configuracion

const CONFIG = {
  // Si es true, el script baja el CSV de un mes incompleto.
  FORZAR_MES_INCOMPLETO: false,
  // Si es true, el script vuelve a leer los dias guardados sin Licencia.
  RELEER_SIN_LICENCIA: false,

  // Pausa minima entre dos dias, en milisegundos.
  PAUSA_BASE_MS: 2500,
  // Tiempo extra al azar que se suma a la pausa base.
  PAUSA_AZAR_MS: 2000,
  // Probabilidad de una pausa larga extra despues de un dia.
  PAUSA_LARGA_PROB: 0.15,
  PAUSA_LARGA_MS: [5000, 9000],
  // Limite de la pausa despues de varios errores.
  PAUSA_MAX_MS: 60000,
  MAX_FALLOS_SEGUIDOS: 3,

  // Solo se usa para mostrar el tiempo estimado.
  MS_POR_DIA_ESTIMADO: 7000,
  TIMEOUT_ABRIR_MS: 10000,
  TIMEOUT_FILAS_MS: 10000,
  CODIGOS_BLOQUEO: [429, 403, 503],
  LS_KEY: "ss_filas",
};

// Selectores. Si Shutterstock cambia el HTML, cambia solo este objeto.

const SEL = {
  celdaFecha: '[data-testid^="DateLinkCell-"]',
  dialogo: '[role="dialog"]',
  tabs: '[data-testid="ProductTabFilters"]',
  tablaAssets: 'table[data-testid="AssetsTable"]',
  paginador: '[data-testid="EarningsDateDialogPagination"]',
  totalPaginas: '[data-testid="pagination-countTotal"]',
  paginaActual: ".MuiPaper-root",
  siguiente: 'button[aria-label="next page"]',
  cerrar: 'button[aria-label="Close"]',
};

// Utilidades

// Cada corrida tiene un token propio.
// Si pegas el script otra vez, la corrida anterior se detiene.
const miToken = Symbol();
window.__token = miToken;
const vivo = () => window.__token === miToken;

const espera = ms => new Promise(r => setTimeout(r, ms));
const azar = (a, b) => a + Math.random() * (b - a);
const aCents = t => Math.round(parseFloat(t.replace(/[$,\s]/g, "")) * 100);
const dolares = c => (c / 100).toFixed(2);
const fmt = ms => {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} s` : `${s} s`;
};

// Parte un total en n partes de centavos enteros.
// El resto se reparte de uno en uno. La suma es exacta.
const partir = (cents, n) => {
  const base = Math.floor(cents / n);
  const resto = cents % n;
  return Array.from({ length: n }, (_, k) => base + (k < resto ? 1 : 0));
};

const OPC_OBS = { childList: true, subtree: true, attributes: true, characterData: true };

// Espera una condicion con MutationObserver. No usa polling.
const esperaPor = (fn, ms, etiqueta, raiz = document.body) => new Promise((ok, mal) => {
  if (!vivo()) return mal(new Error("detenido"));
  const v0 = fn();
  if (v0) return ok(v0);
  let obs;
  let t;
  const fin = () => { obs.disconnect(); clearTimeout(t); };
  obs = new MutationObserver(() => {
    if (!vivo()) { fin(); return mal(new Error("detenido")); }
    const v = fn();
    if (v) { fin(); ok(v); }
  });
  t = setTimeout(() => { fin(); mal(new Error("timeout: " + etiqueta)); }, ms);
  obs.observe(raiz, OPC_OBS);
});

// Espera hasta que el DOM no cambie durante un tiempo.
const esperaQuieto = (raiz, quieto = 150, max = 5000) => new Promise(ok => {
  let t;
  let tope;
  let obs;
  const fin = () => { obs.disconnect(); clearTimeout(t); clearTimeout(tope); ok(); };
  obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(fin, quieto); });
  t = setTimeout(fin, quieto);
  tope = setTimeout(fin, max);
  obs.observe(raiz, OPC_OBS);
});

const leerLS = (k, def) => {
  try { return JSON.parse(localStorage.getItem(k)) || def; } catch (_) { return def; }
};

// Detector de bloqueo y contador de peticiones.
// La bandera __parcheV2 evita instalar el parche dos veces.

if (!window.__parcheV2) {
  window.__parcheV2 = true;
  window.__req = { total: 0, estados: {} };

  const cuenta = s => {
    window.__req.estados[s] = (window.__req.estados[s] || 0) + 1;
  };

  const fetchOriginal = window.fetch;
  window.fetch = async (...a) => {
    window.__req.total++;
    const r = await fetchOriginal(...a);
    cuenta(r.status);
    if (CONFIG.CODIGOS_BLOQUEO.includes(r.status)) window.__alerta = r.status;
    return r;
  };

  const sendOriginal = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    window.__req.total++;
    this.addEventListener("loadend", () => {
      cuenta(this.status);
      if (CONFIG.CODIGOS_BLOQUEO.includes(this.status)) window.__alerta = this.status;
    });
    return sendOriginal.apply(this, a);
  };
}
window.__alerta = null;
window.__req.total = 0;
window.__req.estados = {};

// Metricas de la corrida

const M = {
  t0: Date.now(),
  totalMs: 0,
  pausaMs: 0,
  dias: [],
  ok: 0,
  revisar: 0,
  error: 0,
  pestanas: 0,
  paginas: 0,
  filas: 0,
  ventas: 0,
  partidas: 0,
  errores: {},
  csv: 0,
};
window.__M = M;

// Lectura del modal

const getDialogo = () => [...document.querySelectorAll(SEL.dialogo)]
  .find(x => x.querySelector(SEL.tabs));

const cerrarDialogo = async () => {
  const d = getDialogo();
  if (!d) return;
  const x = d.querySelector(SEL.cerrar);
  if (x) x.click();
  try {
    await esperaPor(() => !getDialogo(), 4000, "cerrar con boton");
  } catch (e) {
    if (e.message === "detenido") throw e;
    const d2 = getDialogo();
    if (d2) {
      d2.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    }
    await esperaPor(() => !getDialogo(), 4000, "cerrar con Escape");
  }
};

// Devuelve las filas visibles de la tabla de assets.
// Cada fila tiene id, n de descargas y c en centavos.
const leerFilas = d => {
  const out = [];
  d.querySelectorAll(`${SEL.tablaAssets} tbody tr`).forEach(tr => {
    const td = tr.querySelectorAll("td");
    if (td.length < 3) return;
    const id = (td[0].innerText.match(/\d{8,}/) || [])[0];
    const n = parseInt(td[1].innerText.trim());
    const c = aCents(td[2].innerText);
    if (!id || !n || isNaN(c)) return;
    out.push({ id, n, c });
  });
  return out;
};

const huellaDe = d => leerFilas(d).map(f => f.id + ":" + f.c).join("|");

// Lee todas las paginas de la pestaña activa.
const leerPestana = async (d, esperadoTab) => {
  const pag = d.querySelector(SEL.paginador) || d;
  const totTxt = pag.querySelector(SEL.totalPaginas);
  const total = totTxt ? parseInt(totTxt.innerText.replace(/\D/g, "")) || 1 : 1;
  const paginaActual = () => {
    const el = pag.querySelector(SEL.paginaActual);
    return el ? el.innerText.trim() : "1";
  };

  let filas = leerFilas(d);
  M.paginas++;

  for (let p = 2; p <= total; p++) {
    const antesPag = paginaActual();
    const antesHuella = huellaDe(d);
    const sig = pag.querySelector(SEL.siguiente);
    if (!sig || sig.disabled) {
      console.warn(`   pagina ${p} de ${total}: no hay boton siguiente`);
      break;
    }
    sig.click();
    await esperaPor(
      () => paginaActual() !== antesPag && huellaDe(d) !== antesHuella,
      8000,
      "pagina " + p,
      d
    );
    await esperaQuieto(d, 150);
    filas = filas.concat(leerFilas(d));
    M.paginas++;
  }

  const cuenta = filas.reduce((a, f) => a + f.n, 0);
  if (esperadoTab != null && cuenta !== esperadoTab) {
    console.warn(`   la pestaña indica ${esperadoTab} descargas, el script leyo ${cuenta}, paginas ${total}`);
  }
  return filas;
};

// Abre cada pestaña con datos y junta sus filas.
// Devuelve tambien los totales esperados del dia.
const leerDia = async (d, fecha) => {
  const titulo = "Assets licensed on " + fecha.slice(5, 7) + "/" + fecha.slice(8, 10) + "/" + fecha.slice(0, 4);
  await esperaPor(() => d.innerText.includes(titulo), 5000, "titulo " + titulo, d);
  await esperaQuieto(d, 150);

  const txt = d.innerText;
  const mT = txt.match(/Daily earnings\s*\$?\s*([\d,.]+)/);
  const mN = txt.match(/Daily downloads\s*(\d+)/);
  if (!mT || !mN) throw new Error("no hay Daily earnings o Daily downloads");
  const espC = aCents(mT[1]);
  const espN = parseInt(mN[1]);

  let filas = [];
  for (const b of d.querySelectorAll(`${SEL.tabs} button`)) {
    const m = (b.getAttribute("data-testid") || "").match(/^(.+) \((\d+)\)$/);
    if (!m || parseInt(m[2]) === 0) continue;

    // El nombre de la pestaña es el tipo de licencia.
    const lic = m[1].trim();
    M.pestanas++;

    let antes = "";
    if (b.getAttribute("aria-selected") !== "true") {
      // Guarda las filas de la pestaña anterior para detectar el cambio.
      antes = huellaDe(d);
      b.click();
      await esperaPor(() => b.getAttribute("aria-selected") === "true", 3000, "pestaña " + lic, d);
    }

    // Despues del clic, la red puede tardar. Espera filas nuevas.
    await esperaPor(() => {
      const h = huellaDe(d);
      return h !== "" && h !== antes;
    }, CONFIG.TIMEOUT_FILAS_MS, "filas de " + lic, d);
    await esperaQuieto(d, 200);

    const de = await leerPestana(d, parseInt(m[2]));
    filas = filas.concat(de.map(f => ({ ...f, lic })));
  }
  return { filas, espN, espC };
};

// Memoria y CSV

// acc guarda las lineas del CSV de cada fecha.
// Cada linea tiene el formato ID,Fecha,Precio,Licencia.
const acc = new Map(Object.entries(leerLS(CONFIG.LS_KEY, {})));
const guardar = () => localStorage.setItem(CONFIG.LS_KEY, JSON.stringify(Object.fromEntries(acc)));

// Asegura que cada linea tenga 4 campos.
const norm = l => {
  const c = l.split(",");
  while (c.length < 4) c.push("");
  return c.join(",");
};
const licDe = l => (l.split(",")[3] || "").trim();

const bajar = (nombre, buf) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(buf, { type: "text/csv" }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// Preparacion

const todas = [...new Set([...document.querySelectorAll(SEL.celdaFecha)]
  .map(b => b.getAttribute("data-testid").replace("DateLinkCell-", "")))];

if (!todas.length) {
  console.error("No hay dias en la tabla. Elige mes y año, espera a que la tabla cargue y pega el script otra vez.");
  return;
}

if (CONFIG.RELEER_SIN_LICENCIA) {
  let n = 0;
  for (const f of todas) {
    if (acc.has(f) && acc.get(f).some(l => !licDe(l))) {
      acc.delete(f);
      n++;
    }
  }
  console.log(`${n} dias sin Licencia se leen otra vez.`);
}
guardar();

const pend = todas.filter(f => !acc.has(f));
console.log(`${todas.length} dias en la tabla. ${todas.length - pend.length} ya estan guardados. ${pend.length} estan pendientes.`);
if (pend.length) {
  const est = pend.length * CONFIG.MS_POR_DIA_ESTIMADO;
  console.log(`Tiempo estimado: ${fmt(est)}, con ${CONFIG.MS_POR_DIA_ESTIMADO / 1000} s por dia.`);
}

// Bucle principal

const malos = new Set();
let pausa = CONFIG.PAUSA_BASE_MS;
let fallos = 0;
let i = 0;
M.t0 = Date.now();

for (const fecha of pend) {
  if (!vivo()) { console.warn("detenido"); return; }
  i++;
  const tDia = Date.now();

  try {
    await cerrarDialogo();
    document.querySelector(`[data-testid="DateLinkCell-${fecha}"]`).click();
    const d = await esperaPor(getDialogo, CONFIG.TIMEOUT_ABRIR_MS, "abrir dialogo");
    const { filas, espN, espC } = await leerDia(d, fecha);
    await cerrarDialogo();

    const n = filas.reduce((a, f) => a + f.n, 0);
    const c = filas.reduce((a, f) => a + f.c, 0);
    const ok = n === espN && c === espC;
    console.log(`[${i}/${pend.length}]`, fecha, `${n} ventas, $${dolares(c)}.`, `Esperado ${espN} ventas, $${dolares(espC)}.`, ok ? "OK" : "REVISAR");
    M.dias.push({ fecha, ms: Date.now() - tDia, estado: ok ? "OK" : "REVISAR" });

    if (ok) {
      const lineas = [];
      for (const f of filas) {
        for (const p of partir(f.c, f.n)) {
          lineas.push(`${f.id},${fecha},${dolares(p)},${f.lic}`);
        }
      }
      acc.set(fecha, lineas);
      guardar();
      M.ok++;
      M.filas += filas.length;
      M.ventas += n;
      M.partidas += filas.filter(f => f.n > 1).length;
      fallos = 0;
      pausa = Math.max(CONFIG.PAUSA_BASE_MS, pausa / 2);
    } else {
      malos.add(fecha);
      M.revisar++;
    }
  } catch (e) {
    if (e.message === "detenido") { console.warn("detenido"); return; }
    console.error(fecha, "ERROR", e.message);
    malos.add(fecha);
    M.error++;
    M.dias.push({ fecha, ms: Date.now() - tDia, estado: "ERROR" });
    const k = e.message.slice(0, 40);
    M.errores[k] = (M.errores[k] || 0) + 1;
    fallos++;
    pausa = Math.min(pausa * 2, CONFIG.PAUSA_MAX_MS);
    try { await cerrarDialogo(); } catch (_) {}
    if (fallos >= CONFIG.MAX_FALLOS_SEGUIDOS) {
      console.error(`${fallos} errores seguidos. El script se detiene.`);
      break;
    }
  }

  if (window.__alerta) {
    console.error(`Posible limite de peticiones. Codigo ${window.__alerta}. El script se detiene.`);
    break;
  }

  const tPausa = Date.now();
  await espera(pausa + azar(0, CONFIG.PAUSA_AZAR_MS));
  if (Math.random() < CONFIG.PAUSA_LARGA_PROB) {
    await espera(azar(...CONFIG.PAUSA_LARGA_MS));
  }
  M.pausaMs += Date.now() - tPausa;

  if (i < pend.length) {
    const prom = (Date.now() - M.t0) / i;
    console.log(`   tiempo restante: ${fmt(prom * (pend.length - i))}. Promedio: ${fmt(prom)} por dia.`);
  }
}
M.totalMs = Date.now() - M.t0;

// CSV por mes. El script baja un mes solo si esta completo.

for (const mes of new Set(todas.map(f => f.slice(0, 7)))) {
  const faltan = todas.filter(f => f.startsWith(mes) && !acc.has(f));
  if (faltan.length && !CONFIG.FORZAR_MES_INCOMPLETO) {
    console.log(`${mes}: incompleto. Faltan ${faltan.length} dias: ${faltan.join(", ")}`);
    continue;
  }

  const buf = ["ID,Fecha,Precio,Licencia\n"];
  const porLic = new Map();
  let nFilas = 0;

  for (const fe of [...acc.keys()].filter(f => f.startsWith(mes)).sort()) {
    for (const l of acc.get(fe)) {
      const ln = norm(l);
      buf.push(ln + "\n");
      nFilas++;
      const c = ln.split(",");
      const lic = (c[3] || "").trim() || "sin dato";
      const r = porLic.get(lic) || { ventas: 0, cents: 0 };
      r.ventas++;
      r.cents += Math.round(parseFloat(c[2]) * 100);
      porLic.set(lic, r);
    }
  }

  bajar(mes + ".csv", buf);
  M.csv++;
  console.log(`${mes}.csv listo. Filas: ${nFilas}.${faltan.length ? " El mes esta incompleto. Se forzo la descarga." : ""}`);
  console.table([...porLic].map(([lic, r]) => ({
    Licencia: lic,
    Ventas: r.ventas,
    Total: "$" + dolares(r.cents),
  })));
  await espera(800);
}

// Resumen de la corrida

console.log("Dias a revisar a mano:", malos.size ? [...malos] : "ninguno");

if (M.dias.length) {
  const ms = M.dias.map(x => x.ms).sort((a, b) => a - b);
  const mediana = ms[Math.floor(ms.length / 2)];
  const promedio = ms.reduce((a, b) => a + b, 0) / ms.length;
  const lento = M.dias.reduce((a, x) => (!a || x.ms > a.ms ? x : a), null);
  const req = window.__req;
  const minutos = M.totalMs / 60000;
  const total = M.ok + M.revisar + M.error;
  const estados = Object.entries(req.estados).map(([k, v]) => `${k}:${v}`).join("  ") || "ninguno";
  const errs = Object.entries(M.errores).map(([k, v]) => `${v}x ${k}`).join(" | ") || "ninguno";

  console.log("Metricas de la corrida");
  console.table([
    { Metrica: "Tiempo total", Valor: fmt(M.totalMs) },
    { Metrica: "Tiempo estimado", Valor: fmt(total * CONFIG.MS_POR_DIA_ESTIMADO) },
    { Metrica: "Dias procesados", Valor: total },
    { Metrica: "OK / REVISAR / ERROR", Valor: `${M.ok} / ${M.revisar} / ${M.error}` },
    { Metrica: "Tasa de exito", Valor: Math.round(M.ok / total * 100) + "%" },
    { Metrica: "Trabajo por dia, promedio y mediana", Valor: `${fmt(promedio)} / ${fmt(mediana)}` },
    { Metrica: "Trabajo por dia, minimo y maximo", Valor: `${fmt(ms[0])} / ${fmt(ms[ms.length - 1])}` },
    { Metrica: "Dia mas lento", Valor: `${lento.fecha}, ${fmt(lento.ms)}, ${lento.estado}` },
    { Metrica: "Tiempo en pausas", Valor: `${fmt(M.pausaMs)}, ${Math.round(M.pausaMs / M.totalMs * 100)}% del total` },
    { Metrica: "Peticiones de red", Valor: `${req.total}, ${(req.total / minutos).toFixed(1)} por minuto` },
    { Metrica: "Estados HTTP", Valor: estados },
    { Metrica: "Pestañas leidas", Valor: M.pestanas },
    { Metrica: "Paginas leidas", Valor: M.paginas },
    { Metrica: "Filas leidas", Valor: M.filas },
    { Metrica: "Ventas leidas", Valor: M.ventas },
    { Metrica: "Filas partidas con n mayor a 1", Valor: M.partidas },
    { Metrica: "Errores por tipo", Valor: errs },
    { Metrica: "Dias pendientes", Valor: pend.length - M.ok },
    { Metrica: "CSV bajados", Valor: M.csv },
  ]);
}
})();
