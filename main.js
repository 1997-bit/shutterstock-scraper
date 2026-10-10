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
 * Lectura de pestañas
 * Despues de un clic en una pestaña, la pagina muestra una tabla de carga.
 * La tabla de carga no tiene IDs de assets.
 * El script espera hasta que la tabla tenga al menos un ID de asset.
 * Si una pestaña devuelve 0 filas, el script la lee otra vez.
 * El script hace hasta 3 intentos por pestaña.
 *
 * Cierre del modal
 * El script guarda el dia antes de cerrar el modal.
 * Si el modal no cierra, el dia no se pierde.
 * El script intenta cerrar el modal otra vez antes del dia siguiente.
 * Si el modal no cierra, el script imprime una tabla de diagnostico.
 *
 * Ingresos sin asset
 * Algunos dias tienen ingresos que no vienen de una descarga.
 * Estos ingresos aparecen en las columnas Image downloads, Video downloads,
 * Customer referrals, Contributor fund y Prize de la tabla mensual.
 * Si el conteo coincide y la diferencia de dinero es igual a la suma de esas columnas,
 * el script guarda el dia.
 * El CSV no incluye esos ingresos, porque no tienen asset.
 * El script los muestra en la consola al final.
 *
 * Memoria
 * El script guarda cada dia valido en localStorage.
 * Cada dia usa una clave propia: ss_d_AAAA-MM-DD.
 * Cada dia es una lista de tuplas [id, centavos, licencia].
 * En la siguiente corrida, el script omite los dias guardados.
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
  // Lista de fechas AAAA-MM-DD que el script guarda aunque el total no cuadre.
  // Usa esta lista solo si la explicacion automatica falla.
  ACEPTAR_DIAS: [],

  // Columnas de la tabla mensual con ingresos de assets.
  COLUMNAS_ASSET: [
    "Subscriptions", "On demand", "Enhanced", "Single & other",
    "Cart sales", "Clip packs", "Enhanced video",
  ],
  // Columnas de la tabla mensual con ingresos sin asset.
  COLUMNAS_EXTRA: [
    "Image downloads", "Video downloads", "Customer referrals",
    "Contributor fund", "Prize",
  ],

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
  // Cada intento de cierre espera este tiempo antes de repetir el clic.
  TIMEOUT_CERRAR_MS: 2500,
  INTENTOS_CERRAR: 3,
  // Intentos para leer una pestaña que devuelve 0 filas.
  INTENTOS_PESTANA: 3,
  // Espera entre dos intentos de lectura de una pestaña.
  ESPERA_REINTENTO_MS: 1500,
  CODIGOS_BLOQUEO: [429, 403, 503],

  // Prefijo de las claves por dia en localStorage.
  LS_DIA: "ss_d_",
  // Clave de la version anterior. El script la migra y la borra.
  LS_VIEJO: "ss_filas",
};

// Selectores. Si Shutterstock cambia el HTML, cambia solo este objeto.

const SEL = {
  celdaFecha: '[data-testid^="DateLinkCell-"]',
  dialogo: '[role="dialog"]',
  tabs: '[data-testid="ProductTabFilters"]',
  tablaAssets: 'table[data-testid="AssetsTable"]',
  cuerpoCarga: "TableLoadingBody",
  paginador: '[data-testid="EarningsDateDialogPagination"]',
  totalPaginas: '[data-testid="pagination-countTotal"]',
  paginaActual: ".MuiPaper-root",
  siguiente: 'button[aria-label="next page"]',
  cerrar: 'button[aria-label="Close"]',
};

// Expresiones regulares. Se compilan una sola vez.

const RE_ECON = /Daily earnings\s*\$?\s*([\d,.]+)/;
const RE_DESC = /Daily downloads\s*(\d+)/;
const RE_ID = /\d{8,}/;
const RE_TAB = /^(.+) \((\d+)\)$/;

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
const ahora = () => performance.now();
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

// Opciones del observer.
// OPC_TODO detecta cambios de texto y de atributos.
// OPC_ARBOL detecta solo nodos nuevos o quitados. Es mas barato.
const OPC_TODO = { childList: true, subtree: true, attributes: true, characterData: true };
const OPC_ARBOL = { childList: true, subtree: true };

// Espera una condicion con MutationObserver. No usa polling.
const esperaPor = (fn, ms, etiqueta, raiz = document.body, opc = OPC_TODO) => new Promise((ok, mal) => {
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
  obs.observe(raiz, opc);
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
  obs.observe(raiz, OPC_TODO);
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
  etapas: { abrir: 0, leer: 0, cerrar: 0, pausa: 0 },
  dias: [],
  ok: 0,
  conExtra: 0,
  revisar: 0,
  error: 0,
  pestanas: 0,
  paginas: 0,
  reintentosPestana: 0,
  filas: 0,
  ventas: 0,
  partidas: 0,
  cierresFallidos: 0,
  errores: {},
  extras: [],
  csv: 0,
};
window.__M = M;

// Lectura de la tabla mensual

// Devuelve un objeto con el valor de cada columna de la fila del dia.
const filaMensual = fecha => {
  const celda = document.querySelector(`[data-testid="DateLinkCell-${fecha}"]`);
  const tr = celda && celda.closest("tr");
  const tabla = tr && tr.closest("table");
  if (!tr || !tabla) return null;
  const cab = [...tabla.querySelectorAll("thead tr:last-child th")].map(th => th.textContent.trim());
  const val = [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
  const fila = {};
  cab.forEach((col, i) => { fila[col] = val[i] || ""; });
  return fila;
};

// Intenta explicar una diferencia de dinero con las columnas sin asset.
// Devuelve null si la fila mensual no explica la diferencia.
const explicarDiferencia = (fecha, leido, esperado) => {
  const fila = filaMensual(fecha);
  if (!fila) return null;
  const valor = col => (fila[col] && fila[col] !== "-" ? aCents(fila[col]) : 0);

  let deAssets = 0;
  for (const col of CONFIG.COLUMNAS_ASSET) deAssets += valor(col);

  const detalle = CONFIG.COLUMNAS_EXTRA
    .map(col => ({ col, c: valor(col) }))
    .filter(x => x.c > 0);
  let extra = 0;
  for (const x of detalle) extra += x.c;

  if (deAssets === leido && leido + extra === esperado) return { extra, detalle };

  const conValor = Object.entries(fila)
    .filter(([, v]) => v && v !== "-")
    .map(([col, v]) => ({ Columna: col, Valor: v }));
  console.warn(`   ${fecha}: la fila mensual no explica la diferencia. Columnas con valor:`);
  console.table(conValor);
  return null;
};

// Lectura del modal

const getDialogo = () => [...document.querySelectorAll(SEL.dialogo)]
  .find(x => x.querySelector(SEL.tabs));

// Imprime datos para entender por que el modal no cierra.
const diagnosticoModal = d => {
  const x = d.querySelector(SEL.cerrar);
  console.warn("Diagnostico del modal que no cierra");
  console.table([
    { Dato: "Sigue en el DOM", Valor: d.isConnected },
    { Dato: "Tiene pestañas", Valor: !!d.querySelector(SEL.tabs) },
    { Dato: "Existe el boton Close", Valor: !!x },
    { Dato: "El boton Close esta deshabilitado", Valor: !!(x && x.disabled) },
    { Dato: "Cantidad de cajas visibles", Valor: d.getClientRects().length },
    { Dato: "Modales en la pagina", Valor: document.querySelectorAll(SEL.dialogo).length },
  ]);
};

// Cierra el modal. Cuenta el modal como cerrado en tres casos.
// Caso 1: el modal ya no esta en el DOM.
// Caso 2: el modal ya no tiene pestañas.
// Caso 3: el modal ya no es visible.
// Si el clic no funciona, repite el clic. Luego prueba la tecla Escape.
const cerrarDialogo = async () => {
  const d = getDialogo();
  if (!d) return;
  const cerrado = () => !d.isConnected || !getDialogo() || d.getClientRects().length === 0;

  for (let intento = 1; intento <= CONFIG.INTENTOS_CERRAR; intento++) {
    const x = d.querySelector(SEL.cerrar);
    if (x) x.click();
    try {
      await esperaPor(cerrado, CONFIG.TIMEOUT_CERRAR_MS, "cerrar con boton");
      return;
    } catch (e) {
      if (e.message === "detenido") throw e;
    }
  }

  d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
  try {
    await esperaPor(cerrado, 4000, "cerrar con Escape");
  } catch (e) {
    if (e.message === "detenido") throw e;
    diagnosticoModal(d);
    throw new Error("timeout: el modal no cierra");
  }
};

// Devuelve las filas visibles de la tabla de assets.
// Cada fila tiene id, n de descargas y c en centavos.
// textContent no fuerza el calculo de layout. innerText si lo fuerza.
const leerFilas = d => {
  const out = [];
  d.querySelectorAll(`${SEL.tablaAssets} tbody tr`).forEach(tr => {
    const td = tr.querySelectorAll("td");
    if (td.length < 3) return;
    const id = (td[0].textContent.match(RE_ID) || [])[0];
    const n = parseInt(td[1].textContent.trim());
    const c = aCents(td[2].textContent);
    if (!id || !n || isNaN(c)) return;
    out.push({ id, n, c });
  });
  return out;
};

// Firma del contenido de la tabla.
// Devuelve texto vacio si la tabla esta en carga o si no hay un ID de asset.
const firma = d => {
  const tb = d.querySelector(`${SEL.tablaAssets} tbody`);
  if (!tb) return "";
  if (tb.getAttribute("data-testid") === SEL.cuerpoCarga) return "";
  const txt = tb.textContent;
  return RE_ID.test(txt) ? txt : "";
};

// Lee todas las paginas de la pestaña activa.
const leerPestana = async d => {
  const pag = d.querySelector(SEL.paginador) || d;
  const totTxt = pag.querySelector(SEL.totalPaginas);
  const total = totTxt ? parseInt(totTxt.textContent.replace(/\D/g, "")) || 1 : 1;
  const paginaActual = () => {
    const el = pag.querySelector(SEL.paginaActual);
    return el ? el.textContent.trim() : "1";
  };

  const filas = leerFilas(d);
  M.paginas++;

  for (let p = 2; p <= total; p++) {
    const antesPag = paginaActual();
    const antesFirma = firma(d);
    const sig = pag.querySelector(SEL.siguiente);
    if (!sig || sig.disabled) {
      console.warn(`   pagina ${p} de ${total}: no hay boton siguiente`);
      break;
    }
    sig.click();
    await esperaPor(
      () => paginaActual() !== antesPag && firma(d) !== "" && firma(d) !== antesFirma,
      8000,
      "pagina " + p,
      d
    );
    await esperaQuieto(d, 150);
    for (const f of leerFilas(d)) filas.push(f);
    M.paginas++;
  }
  return filas;
};

// Abre cada pestaña con datos y junta sus filas.
// Devuelve tambien los totales esperados del dia.
const leerDia = async (d, fecha) => {
  const titulo = "Assets licensed on " + fecha.slice(5, 7) + "/" + fecha.slice(8, 10) + "/" + fecha.slice(0, 4);
  await esperaPor(() => d.textContent.includes(titulo), 5000, "titulo " + titulo, d);
  await esperaQuieto(d, 150);

  // innerText se usa una sola vez por dia, para conservar los espacios.
  const txt = d.innerText;
  const mT = txt.match(RE_ECON);
  const mN = txt.match(RE_DESC);
  if (!mT || !mN) throw new Error("no hay Daily earnings o Daily downloads");
  const espC = aCents(mT[1]);
  const espN = parseInt(mN[1]);

  const filas = [];
  for (const b of d.querySelectorAll(`${SEL.tabs} button`)) {
    const m = (b.getAttribute("data-testid") || "").match(RE_TAB);
    if (!m || parseInt(m[2]) === 0) continue;

    // El nombre de la pestaña es el tipo de licencia.
    const lic = m[1].trim();
    const esperadoTab = parseInt(m[2]);
    M.pestanas++;

    let antes = "";
    if (b.getAttribute("aria-selected") !== "true") {
      // Guarda la firma de la pestaña anterior para detectar el cambio.
      antes = firma(d);
      b.click();
      await esperaPor(() => b.getAttribute("aria-selected") === "true", 3000, "pestaña " + lic, d);
    }

    // Espera filas reales. Una tabla en carga tiene firma vacia.
    await esperaPor(() => {
      const h = firma(d);
      return h !== "" && h !== antes;
    }, CONFIG.TIMEOUT_FILAS_MS, "filas de " + lic, d);
    await esperaQuieto(d, 200);

    // Si la pestaña devuelve 0 filas, espera y lee otra vez.
    let de = [];
    for (let intento = 1; intento <= CONFIG.INTENTOS_PESTANA; intento++) {
      de = await leerPestana(d);
      if (de.length > 0) break;
      M.reintentosPestana++;
      console.warn(`   pestaña ${lic}: 0 filas, intento ${intento} de ${CONFIG.INTENTOS_PESTANA}`);
      await espera(CONFIG.ESPERA_REINTENTO_MS);
    }

    let cuenta = 0;
    for (const f of de) {
      f.lic = lic;
      filas.push(f);
      cuenta += f.n;
    }
    if (cuenta !== esperadoTab) {
      console.warn(`   la pestaña ${lic} indica ${esperadoTab} descargas, el script leyo ${cuenta}`);
    }
  }
  return { filas, espN, espC };
};

// Memoria
// acc relaciona cada fecha con una lista de tuplas [id, centavos, licencia].

const acc = new Map();

// Carga la memoria. Migra la clave de la version anterior si existe.
const cargarMemoria = () => {
  const viejo = leerLS(CONFIG.LS_VIEJO, null);
  if (viejo) {
    for (const [fecha, lineas] of Object.entries(viejo)) {
      const filas = lineas.map(l => {
        const c = l.split(",");
        return [c[0], Math.round(parseFloat(c[2]) * 100), (c[3] || "").trim()];
      });
      acc.set(fecha, filas);
      localStorage.setItem(CONFIG.LS_DIA + fecha, JSON.stringify(filas));
    }
    localStorage.removeItem(CONFIG.LS_VIEJO);
    console.log(`Memoria vieja migrada: ${acc.size} dias.`);
  }
  for (let k = 0; k < localStorage.length; k++) {
    const clave = localStorage.key(k);
    if (!clave || !clave.startsWith(CONFIG.LS_DIA)) continue;
    const fecha = clave.slice(CONFIG.LS_DIA.length);
    if (!acc.has(fecha)) acc.set(fecha, leerLS(clave, []));
  }
};

// Guarda un solo dia. El costo no depende de cuantos dias hay guardados.
const guardarDia = fecha => {
  try {
    localStorage.setItem(CONFIG.LS_DIA + fecha, JSON.stringify(acc.get(fecha)));
  } catch (e) {
    console.warn("No se pudo guardar el dia " + fecha + ": " + e.message);
  }
};

const borrarDia = fecha => {
  acc.delete(fecha);
  localStorage.removeItem(CONFIG.LS_DIA + fecha);
};

const bajar = (nombre, buf) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(buf, { type: "text/csv" }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// Preparacion

cargarMemoria();

const todas = [...new Set([...document.querySelectorAll(SEL.celdaFecha)]
  .map(b => b.getAttribute("data-testid").replace("DateLinkCell-", "")))];

if (!todas.length) {
  console.error("No hay dias en la tabla. Elige mes y año, espera a que la tabla cargue y pega el script otra vez.");
  return;
}

// Agrupa los dias de la tabla por mes. Se hace una sola vez.
const tablaPorMes = new Map();
for (const f of todas) {
  const mes = f.slice(0, 7);
  if (!tablaPorMes.has(mes)) tablaPorMes.set(mes, []);
  tablaPorMes.get(mes).push(f);
}

if (CONFIG.RELEER_SIN_LICENCIA) {
  let n = 0;
  for (const f of todas) {
    if (acc.has(f) && acc.get(f).some(r => !r[2])) {
      borrarDia(f);
      n++;
    }
  }
  console.log(`${n} dias sin Licencia se leen otra vez.`);
}

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
  const tDia = ahora();

  try {
    // Asegura que no queda un modal abierto del dia anterior.
    await cerrarDialogo();

    let t = ahora();
    document.querySelector(`[data-testid="DateLinkCell-${fecha}"]`).click();
    const d = await esperaPor(getDialogo, CONFIG.TIMEOUT_ABRIR_MS, "abrir dialogo", document.body, OPC_ARBOL);
    M.etapas.abrir += ahora() - t;

    t = ahora();
    const { filas, espN, espC } = await leerDia(d, fecha);
    M.etapas.leer += ahora() - t;

    let n = 0;
    let c = 0;
    for (const f of filas) { n += f.n; c += f.c; }

    // El dia cuadra, o una columna sin asset explica la diferencia, o el dia esta en la lista manual.
    const cuadra = n === espN && c === espC;
    const extra = !cuadra && n === espN ? explicarDiferencia(fecha, c, espC) : null;
    const manual = !cuadra && !extra && CONFIG.ACEPTAR_DIAS.includes(fecha);
    const ok = cuadra || extra !== null || manual;
    const estado = cuadra ? "OK" : extra ? "OK_CON_EXTRA" : manual ? "ACEPTADO_MANUAL" : "REVISAR";

    console.log(`[${i}/${pend.length}]`, fecha, `${n} ventas, $${dolares(c)}.`, `Esperado ${espN} ventas, $${dolares(espC)}.`, estado);
    M.dias.push({ fecha, ms: ahora() - tDia, estado });

    if (extra) {
      const txtExtra = extra.detalle.map(x => `${x.col} $${dolares(x.c)}`).join(", ");
      console.log(`   Ingresos sin asset: $${dolares(extra.extra)}. Columnas: ${txtExtra}. No estan en el CSV.`);
      M.extras.push({ fecha, monto: "$" + dolares(extra.extra), columnas: txtExtra });
      M.conExtra++;
    }
    if (manual) {
      console.warn(`   ${fecha}: diferencia de $${dolares(espC - c)} sin explicar. No esta en el CSV.`);
    }

    if (ok) {
      const registros = [];
      for (const f of filas) {
        for (const p of partir(f.c, f.n)) registros.push([f.id, p, f.lic]);
      }
      acc.set(fecha, registros);
      guardarDia(fecha);
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

    // Cierra el modal. El dia ya esta procesado.
    // Si el cierre falla, el script no pierde el dia.
    t = ahora();
    try {
      await cerrarDialogo();
    } catch (e) {
      if (e.message === "detenido") throw e;
      M.cierresFallidos++;
      console.warn(`   el modal no cerro: ${e.message}. El dia ${fecha} no se pierde.`);
    }
    M.etapas.cerrar += ahora() - t;
  } catch (e) {
    if (e.message === "detenido") { console.warn("detenido"); return; }
    console.error(fecha, "ERROR", e.message);
    malos.add(fecha);
    M.error++;
    M.dias.push({ fecha, ms: ahora() - tDia, estado: "ERROR" });
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

  const tPausa = ahora();
  await espera(pausa + azar(0, CONFIG.PAUSA_AZAR_MS));
  if (Math.random() < CONFIG.PAUSA_LARGA_PROB) {
    await espera(azar(...CONFIG.PAUSA_LARGA_MS));
  }
  M.etapas.pausa += ahora() - tPausa;

  if (i < pend.length) {
    const prom = (Date.now() - M.t0) / i;
    console.log(`   tiempo restante: ${fmt(prom * (pend.length - i))}. Promedio: ${fmt(prom)} por dia.`);
  }
}
M.totalMs = Date.now() - M.t0;

// CSV por mes. El script baja un mes solo si esta completo.

// Agrupa los dias guardados por mes. Se hace una sola vez.
const guardadosPorMes = new Map();
for (const f of acc.keys()) {
  const mes = f.slice(0, 7);
  if (!tablaPorMes.has(mes)) continue;
  if (!guardadosPorMes.has(mes)) guardadosPorMes.set(mes, []);
  guardadosPorMes.get(mes).push(f);
}

for (const [mes, diasTabla] of tablaPorMes) {
  const faltan = diasTabla.filter(f => !acc.has(f));
  if (faltan.length && !CONFIG.FORZAR_MES_INCOMPLETO) {
    console.log(`${mes}: incompleto. Faltan ${faltan.length} dias: ${faltan.join(", ")}`);
    continue;
  }

  const buf = ["ID,Fecha,Precio,Licencia\n"];
  const porLic = new Map();
  let nFilas = 0;

  const dias = (guardadosPorMes.get(mes) || []).sort();
  for (const fe of dias) {
    for (const [id, cents, lic] of acc.get(fe)) {
      buf.push(`${id},${fe},${dolares(cents)},${lic}\n`);
      nFilas++;
      const clave = lic || "sin dato";
      const r = porLic.get(clave) || { ventas: 0, cents: 0 };
      r.ventas++;
      r.cents += cents;
      porLic.set(clave, r);
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

if (M.extras.length) {
  console.log("Ingresos sin asset. Estos ingresos no estan en el CSV.");
  console.table(M.extras);
}

if (M.dias.length) {
  const ms = M.dias.map(x => x.ms).sort((a, b) => a - b);
  const mediana = ms[Math.floor(ms.length / 2)];
  const promedio = ms.reduce((a, b) => a + b, 0) / ms.length;
  const lento = M.dias.reduce((a, x) => (!a || x.ms > a.ms ? x : a), null);
  const req = window.__req;
  const minutos = M.totalMs / 60000;
  const total = M.ok + M.revisar + M.error;
  const pct = x => Math.round(x / M.totalMs * 100) + "%";
  const estados = Object.entries(req.estados).map(([k, v]) => `${k}:${v}`).join("  ") || "ninguno";
  const errs = Object.entries(M.errores).map(([k, v]) => `${v}x ${k}`).join(" | ") || "ninguno";
  const e = M.etapas;

  console.log("Metricas de la corrida");
  console.table([
    { Metrica: "Tiempo total", Valor: fmt(M.totalMs) },
    { Metrica: "Tiempo estimado", Valor: fmt(total * CONFIG.MS_POR_DIA_ESTIMADO) },
    { Metrica: "Dias procesados", Valor: total },
    { Metrica: "Guardados / REVISAR / ERROR", Valor: `${M.ok} / ${M.revisar} / ${M.error}` },
    { Metrica: "Guardados con ingresos sin asset", Valor: M.conExtra },
    { Metrica: "Reintentos de pestaña", Valor: M.reintentosPestana },
    { Metrica: "Cierres de modal fallidos", Valor: M.cierresFallidos },
    { Metrica: "Tasa de exito", Valor: Math.round(M.ok / total * 100) + "%" },
    { Metrica: "Trabajo por dia, promedio y mediana", Valor: `${fmt(promedio)} / ${fmt(mediana)}` },
    { Metrica: "Trabajo por dia, minimo y maximo", Valor: `${fmt(ms[0])} / ${fmt(ms[ms.length - 1])}` },
    { Metrica: "Dia mas lento", Valor: `${lento.fecha}, ${fmt(lento.ms)}, ${lento.estado}` },
    { Metrica: "Etapa abrir modal", Valor: `${fmt(e.abrir)}, ${pct(e.abrir)}` },
    { Metrica: "Etapa leer datos", Valor: `${fmt(e.leer)}, ${pct(e.leer)}` },
    { Metrica: "Etapa cerrar modal", Valor: `${fmt(e.cerrar)}, ${pct(e.cerrar)}` },
    { Metrica: "Etapa pausa", Valor: `${fmt(e.pausa)}, ${pct(e.pausa)}` },
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
