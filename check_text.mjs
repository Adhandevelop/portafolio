// check_text.js
// Requiere Node 18+
// npm install xlsx
//
// Uso:
// node check_text.js --file=numeros.xlsx --col=A --base=https://mi-pagina.com --text="Bienvenido a prueba" --concurrency=2 --rps=0.5 --outfile=resultados.csv
// node check_text.mjs \
//   --file=numeros_limpios.csv \
//   --col=A \
//   --base=https://app.udeki.com/login?id \
//   --text="Bienvenido a Udeki" \
//   --concurrency=1 \
//   --rps= 1  \
//   --outfile=resultados_3seg.csv
import fs from 'fs';
import { promisify } from 'util';
import xlsx from 'xlsx';
import { setTimeout as delay } from 'timers/promises';

const argv = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const [k, v] = s.split('=');
    return [k.replace(/^--/, ''), v ?? true];
  })
);

if (!argv.file || !argv.base || !argv.text) {
  console.error(`Faltan parámetros.
Ejemplo:
node check_text.js --file=numeros.xlsx --col=A --base=https://mi-pagina.com --text="Bienvenido a prueba" --concurrency=2 --rps=0.5`);
  process.exit(1);
}

// Configuración
const FILE = argv.file;
const COL = argv.col || 'A';
const BASE = argv.base.replace(/\/+$/, '');
const SEARCH_TEXT = argv.text;
const CONCURRENCY = parseInt(argv.concurrency || '2', 10);
const RPS = parseFloat(argv.rps || '0.5', 10);
const MIND_DELAY = parseInt(argv.mindelay || '1000', 10);
const OUTFILE = argv.outfile || 'resultados.csv';
const RETRIES = parseInt(argv.retries || '2', 10);
const TIMEOUT_MS = parseInt(argv.timeout || '15000', 10);

const appendFile = promisify(fs.appendFile);
if (!fs.existsSync(OUTFILE)) {
  fs.writeFileSync(OUTFILE, 'id,url,status,timeMs,found,h3_content\n');
}

console.log(`🔍 Escaneo configurado:
 Archivo: ${FILE}
 Base: ${BASE}
 Frase: "${SEARCH_TEXT}"
 Concurrencia: ${CONCURRENCY}
 RPS: ${RPS}
 Mindelay: ${MIND_DELAY}
 Output: ${OUTFILE}
`);

function readIds(file, col) {
  if (file.endsWith('.csv')) {
    const txt = fs.readFileSync(file, 'utf8');
    return txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  }
  const wb = xlsx.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const ids = [];
  let row = 1;
  while (true) {
    const cell = ws[`${col}${row}`];
    if (!cell) break;
    const val = String(cell.v).trim();
    if (val) ids.push(val);
    row++;
  }
  return ids;
}

const ids = readIds(FILE, COL);
console.log(`📄 ${ids.length} IDs cargados`);

function createQueue(concurrency) {
  let active = 0;
  const tasks = [];
  const next = () => {
    if (tasks.length === 0 || active >= concurrency) return;
    const { fn, resolve } = tasks.shift();
    active++;
    fn().then(res => { active--; resolve(res); next(); }).catch(err => { active--; resolve(Promise.reject(err)); next(); });
  };
  return {
    push(fn) {
      return new Promise(resolve => {
        tasks.push({ fn, resolve });
        next();
      });
    },
    idle() {
      return new Promise(resolve => {
        const check = () => {
          if (active === 0 && tasks.length === 0) return resolve();
          setTimeout(check, 200);
        };
        check();
      });
    }
  };
}

const queue = createQueue(CONCURRENCY);

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': 'check-text/1.0 (+contacto@tusitio.com)' };
    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function processId(id) {
  const url = `${BASE}=${id}`;
  const start = Date.now();
  let attempts = 0;
  let lastErr = '';

  for (; attempts <= RETRIES; attempts++) {
    try {
      await delay(1000 / RPS + Math.floor(Math.random() * MIND_DELAY));
      const res = await fetchWithTimeout(url, TIMEOUT_MS);
      const html = await res.text();
      
      // NUEVO: Extraer el contenido de la etiqueta h3
      const h3Match = html.match(/<h3 class="mb-1 text-center"[^>]*>(.*?)<\/h3>/i);
      const h3Content = h3Match ? h3Match[1].trim() : 'NO_ENCONTRADO';
      
      // Buscar si contiene "Bienvenido a Udeki"
      const found = h3Content.includes('Bienvenido a Udeki');
      // console.log(h3Match)
      
      const status = res.status;
      const timeMs = Date.now() - start;
      const result = found ? 'SI' : 'NO';
      
      // NUEVO: Agregar el contenido del h3 al CSV
      await appendFile(OUTFILE, `"${id}","${url}",${status},${timeMs},"${result}","${h3Content}"\n`);
      
      // NUEVO: Mostrar en consola lo que encuentra
      console.log(`${id}: "${h3Content}" -> ${result}`);
      
      return { id, found, status, timeMs, h3Content };
    } catch (err) {
      lastErr = err.message || String(err);
      const backoff = 400 * (2 ** attempts);
      console.warn(`⚠️ Error ${id}: ${lastErr}, reintentando en ${backoff}ms`);
      await delay(backoff);
    }
  }

  const timeMs = Date.now() - start;
  await appendFile(OUTFILE, `"${id}","${url}","","","ERROR","${lastErr}"\n`);
}

let processed = 0;
for (const id of ids) {
  queue.push(async () => {
    const r = await processId(id);
    processed++;
    if (processed % 100 === 0) console.log(`➡️ ${processed}/${ids.length}`);
    return r;
  }).catch(console.error);
}

await queue.idle();
console.log(`✅ Terminado. Resultados guardados en ${OUTFILE}`);
