// Teste de carga do ONE (não faz parte do npm test). Sobe o servidor (Rust por padrão), faz carga mista com escrita,
// segura milhares de conexões abertas ao mesmo tempo e acompanha a memória do processo.
//
//   node tests/carga.js                                   Rust release (rust/target/release/one-node)
//   CARGA_COMANDO='["node","src/server.js"]' node tests/carga.js        o servidor em JavaScript, para comparar
//   CARGA_SEGUNDOS=60 CARGA_CONEX=64 CARGA_PARADAS=3000 node tests/carga.js
//
// O cliente é o próprio Node: a vazão medida tem o teto dele. Use os números para comparar servidores e achar vazamento
// ou travamento, não como capacidade máxima.
const { spawn, execFileSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const RAIZ = path.join(__dirname, '..');
const COMANDO = process.env.CARGA_COMANDO ? JSON.parse(process.env.CARGA_COMANDO) : [path.join(RAIZ, 'rust', 'target', 'release', process.platform === 'win32' ? 'one-node.exe' : 'one-node')];
const SEGUNDOS = Number(process.env.CARGA_SEGUNDOS) || 20;
const CONEX = Number(process.env.CARGA_CONEX) || 64;
const PARADAS = Number(process.env.CARGA_PARADAS) || 2000; // conexões abertas ao mesmo tempo na fase B
const TOKEN = 'ti-carga';

// Porta livre entre 3900 e 3999 (faixa reservada a servidores de teste; 3456 e 3480 são de outras sessões e nunca entram)
const tentar = (porta) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(porta, '127.0.0.1', () => s.close(() => r(true))); });
const livre = async () => { for (let p = 3900; p < 4000; p++) if (await tentar(p)) return p; throw new Error('nenhuma porta livre de 3900 a 3999'); };

function memoriaMB(pid) {
  try {
    if (process.platform === 'win32') {
      const o = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' });
      return Math.round(Number(o.trim()) / 1048576);
    }
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024);
  } catch { return NaN; }
}

const pct = (v, p) => v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : NaN;

(async () => {
  const porta = await livre();
  const semente = path.join(os.tmpdir(), `one-carga-${process.pid}.json`);
  fs.writeFileSync(semente, '[]');
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(porta), KENDJI_DEMO: '1',
    KENDJI_TOKEN_INTEGRACAO: TOKEN, KENDJI_LIMITE_CHAVE: '100000000', KENDJI_LIMITE_INVALIDAS: '100000000', KENDJI_SEMENTE_ARQUIVO: semente,
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('KENDJI_IDEMPOTENCIA_'))),
  };
  const filho = spawn(COMANDO[0], COMANDO.slice(1), { env, cwd: RAIZ, stdio: ['ignore', 'ignore', 'inherit'], shell: false });
  const parar = () => { try { filho.kill(); } catch { /* já saiu */ } try { fs.unlinkSync(semente); } catch { /* já apagado */ } };
  process.on('exit', parar);
  for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${porta}/saude`)).status === 200) break; } catch { /* subindo */ } await new Promise((r) => setTimeout(r, 25)); }
  const agente = new http.Agent({ keepAlive: true, maxSockets: CONEX });
  const chamar = (metodo, caminho, corpo) => new Promise((resolve) => {
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, agent: agente, headers: { Authorization: `Bearer ${TOKEN}`, ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {}) } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ s: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    });
    req.on('error', () => resolve({ s: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    req.setTimeout(20000, () => req.destroy());
    if (dados) req.write(dados);
    req.end();
  });

  // conhecimento para a busca
  await chamar('POST', '/empresas/empresa_1/conhecimento', { tipo: 'tabela', titulo: 'Preços', tabela: { colunas: ['Item', 'Preço'], linhas: Array.from({ length: 200 }, (_, i) => [`Prato ${i}`, `R$ ${i}`]) } });

  let seq = 0;
  const operacao = () => {
    const r = Math.random();
    const n = ++seq;
    const emp = `empresa_${1 + (n % 3)}`;
    if (r < 0.4) return ['GET', `/empresas/${emp}/agente`];
    if (r < 0.6) return ['GET', `/empresas/${emp}/disponibilidade?data=2027-0${1 + (n % 9)}-1${n % 9}&horario=${String(12 + (n % 10)).padStart(2, '0')}:00&pessoas=${1 + (n % 5)}`];
    if (r < 0.8) {
      const dia = 1 + (n % 28), mes = 1 + (Math.floor(n / 28) % 12), hora = 11 + (n % 12);
      return ['POST', `/empresas/${emp}/reservas`, { data: `2027-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`, horario: `${hora}:00`, pessoas: 2, ambiente: 'salao', nomeCliente: `Cliente ${n}` }];
    }
    if (r < 0.9) return ['GET', `/empresas/${emp}/conhecimento/buscar?q=prato+${n % 200}`];
    return ['GET', '/saude'];
  };
  // POST de reserva precisa de Idempotency-Key: o corpo carrega "chave" (a API aceita no corpo)
  const executar = (op) => (op[0] === 'POST' ? chamar('POST', op[1], { ...op[2], chave: `c${seq}-${Math.random()}` }) : chamar(op[0], op[1]));

  async function fase(rotulo, segundos) {
    const lat = [];
    const status = {};
    const fim = Date.now() + segundos * 1000;
    let total = 0;
    const amostras = [];
    const sondagem = setInterval(() => amostras.push(memoriaMB(filho.pid)), Math.max(2000, segundos * 1000 / 6));
    const trabalhador = async () => {
      while (Date.now() < fim) {
        const r = await executar(operacao());
        total++;
        lat.push(r.ms);
        status[r.s] = (status[r.s] || 0) + 1;
      }
    };
    await Promise.all(Array.from({ length: CONEX }, trabalhador));
    clearInterval(sondagem);
    lat.sort((a, b) => a - b);
    return { rotulo, segundos, conexoes: CONEX, total, rps: Math.round(total / segundos), status, p50: pct(lat, 0.5).toFixed(2), p95: pct(lat, 0.95).toFixed(2), p99: pct(lat, 0.99).toFixed(2), max: lat[lat.length - 1].toFixed(1), memoriaMB: amostras.filter(Number.isFinite) };
  }

  console.log(`Servidor: ${COMANDO.join(' ')} (pid ${filho.pid}); cliente: ${CONEX} conexões, ${SEGUNDOS} s`);
  const mem0 = memoriaMB(filho.pid);
  const a = await fase('A) carga mista (40% GET agente, 20% disponibilidade, 20% POST reserva, 10% busca, 10% saude)', SEGUNDOS);
  console.log(JSON.stringify(a));

  // Fase B: muitas conexões abertas ao mesmo tempo, todas pedindo /saude
  const abertas = [];
  let respondidas = 0, falhas = 0;
  const codigos = {}; // motivo de cada conexão que falhou (erro do lado do cliente, como EADDRNOTAVAIL, ou do servidor)
  const t0 = Date.now();
  await new Promise((resolve) => {
    let feitas = 0;
    const fim1 = () => { if (++feitas === PARADAS) resolve(); };
    for (let i = 0; i < PARADAS; i++) {
      const s = net.connect(porta, '127.0.0.1');
      abertas.push(s);
      let buf = '';
      s.on('connect', () => s.write('GET /saude HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { buf += d; if (buf.includes('{"ok":true}')) { respondidas++; s.removeAllListeners('data'); fim1(); } });
      s.on('error', (e) => { falhas++; codigos[e.code || e.message] = (codigos[e.code || e.message] || 0) + 1; fim1(); });
    }
  });
  const memB = memoriaMB(filho.pid);
  const vivo = (await chamar('GET', '/saude')).s;
  abertas.forEach((s) => s.destroy());
  console.log(JSON.stringify({ rotulo: `B) ${PARADAS} conexões abertas ao mesmo tempo`, respondidas, falhas, motivosDasFalhas: codigos, segundos: ((Date.now() - t0) / 1000).toFixed(2), memoriaMB: memB, saudeDepois: vivo }));

  await new Promise((r) => setTimeout(r, 1500));
  const c = await fase('C) mesma carga mista depois das conexões abertas (confere recuperação)', Math.max(5, Math.round(SEGUNDOS / 2)));
  console.log(JSON.stringify(c));
  const reservas = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: porta, path: '/empresas/empresa_1/reservas', headers: { Authorization: `Bearer ${TOKEN}` }, agent: false }, (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve(JSON.parse(t).length)); });
  });
  console.log(JSON.stringify({ memoriaInicialMB: mem0, memoriaFinalMB: memoriaMB(filho.pid), reservasNaEmpresa1: reservas }));
  const falhou = a.status[0] || c.status[0] || a.status[500] || c.status[500] || falhas > 0 || respondidas < PARADAS || vivo !== 200;
  console.log(falhou ? 'RESULTADO: houve falha (status 0/500, conexão perdida ou servidor sem responder)' : 'RESULTADO: sem erros (nenhum status 0 ou 500, todas as conexões respondidas, servidor vivo)');
  parar();
  process.exitCode = falhou ? 1 : 0;
})();
