'use strict';

// Operação do SQLite em produção (TASK-014): arquivo .pid, desligamento por sinal, checkpoint do WAL e restauração.
// Sobe o servidor de verdade como processo filho (src/server.js) com CHATFLOW_BANCO=sqlite.
// Portas de 3930 a 3999 (faixa reservada a servidores de teste).
const nodeTest = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { restaurar } = require('../scripts/restaurar-sqlite');
const { fazerBackup } = require('../scripts/backup-sqlite');

const test = nodeTest;

const RAIZ = path.join(__dirname, '..');
const PRE = require('node:url').pathToFileURL(path.join(__dirname, 'auxiliar', 'sinal-ipc.mjs')).href;
const AUTH = { authorization: 'Bearer ti-op', 'content-type': 'application/json' };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

const portaLivre = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
let proxima = 3930;
async function porta() { for (; proxima < 4000; proxima++) if (await portaLivre(proxima)) return proxima++; throw new Error('sem porta livre'); }

function requisitar(p, rota, { metodo = 'GET', corpo, headers = {} } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ port: p, path: rota, method: metodo, headers }, (x) => {
      let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => resolve({ status: x.statusCode, corpo: b }));
    });
    r.on('error', () => resolve(null));
    r.setTimeout(3000, () => r.destroy());
    if (corpo) r.write(corpo);
    r.end();
  });
}

const filhos = [];
async function iniciar(arquivo, extra = {}) {
  const p = await porta();
  const env = { ...process.env, CHATFLOW_BANCO: 'sqlite', CHATFLOW_BANCO_ARQUIVO: arquivo, PORT: String(p), CHATFLOW_TOKEN_INTEGRACAO: 'ti-op', ...extra };
  const child = spawn(process.execPath, ['--import', PRE, 'src/server.js'], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const o = { child, porta: p, saida: '', encerrou: null };
  child.stdout.on('data', (c) => { o.saida += c; });
  child.stderr.on('data', (c) => { o.saida += c; });
  o.fim = new Promise((r) => child.on('exit', (code, sinal) => { o.encerrou = { code, sinal }; r(o.encerrou); }));
  filhos.push(o);
  return o;
}
async function pronto(o, ms = 10000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (o.encerrou) return false;
    const r = await requisitar(o.porta, '/saude');
    if (r && r.status === 200) return true;
    await dorme(100);
  }
  return false;
}
const ate = (o, ms) => Promise.race([o.fim, dorme(ms).then(() => null)]);
// No Windows o sinal só chega ao manipulador se for emitido dentro do filho (ver auxiliar/sinal-ipc.mjs).
function sinal(o, nome) { if (process.platform === 'win32') o.child.send(nome); else o.child.kill(nome); }
async function matar(o) { if (!o.encerrou) { o.child.kill('SIGKILL'); await o.fim; } }
async function criarEmpresas(o, n) {
  for (let i = 0; i < n; i++) {
    const r = await requisitar(o.porta, '/empresas', { metodo: 'POST', headers: AUTH, corpo: JSON.stringify({ nome: `Empresa ${i} ${Date.now()}` }) });
    assert.strictEqual(r && r.status, 201, `criar empresa ${i}`);
  }
}
const contarEmpresas = (arquivo) => {
  const db = new DatabaseSync(arquivo, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) n FROM empresas').get().n; } finally { db.close(); }
};
const tamanho = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
const pidDe = (arquivo) => (fs.existsSync(`${arquivo}.pid`) ? fs.readFileSync(`${arquivo}.pid`, 'utf8').trim() : null);

function ambiente() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'chatflow-op-'));
  return { raiz, arquivo: path.join(raiz, 'op.sqlite'), limpar: () => fs.rmSync(raiz, { recursive: true, force: true }) };
}

test.after(async () => { for (const o of filhos) await matar(o); });

test('duas instâncias no mesmo banco: a segunda recusa com mensagem clara e não mexe no .pid da primeira', async () => {
  const a = ambiente();
  try {
    const um = await iniciar(a.arquivo);
    assert.ok(await pronto(um), um.saida);
    assert.strictEqual(pidDe(a.arquivo), String(um.child.pid));
    const dois = await iniciar(a.arquivo);
    const fim = await ate(dois, 8000);
    assert.ok(fim && fim.code !== 0, `a segunda deveria sair com erro: ${JSON.stringify(fim)}\n${dois.saida}`);
    assert.match(dois.saida, /parece estar rodando.*PID \d+/);
    assert.strictEqual(pidDe(a.arquivo), String(um.child.pid), '.pid da primeira intacto');
    assert.strictEqual((await requisitar(um.porta, '/saude')).status, 200, 'a primeira segue servindo');
    assert.deepStrictEqual(fs.readdirSync(a.raiz).filter((n) => /tmp|novo|parcial/i.test(n)), [], 'sem arquivo temporário sobrando');
    await matar(um);
  } finally { a.limpar(); }
});

test('.pid velho depois de kill -9: reconhece processo morto, assume, e os dados confirmados sobrevivem', async () => {
  const a = ambiente();
  try {
    const um = await iniciar(a.arquivo);
    assert.ok(await pronto(um), um.saida);
    await criarEmpresas(um, 5);
    await matar(um); // SIGKILL: nenhum manipulador roda
    assert.strictEqual(pidDe(a.arquivo), String(um.child.pid), 'o .pid velho ficou');
    const dois = await iniciar(a.arquivo);
    assert.ok(await pronto(dois), dois.saida);
    assert.strictEqual(pidDe(a.arquivo), String(dois.child.pid));
    const lista = await requisitar(dois.porta, '/empresas', { headers: AUTH });
    assert.strictEqual((lista.corpo.match(/"nome"/g) || []).length, 5);
    await matar(dois);
  } finally { a.limpar(); }
});

test('.pid de OUTRO processo vivo (reaproveitamento de pid): recusa e não apaga o arquivo; pid inexistente é assumido', async () => {
  const a = ambiente();
  const intruso = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await dorme(300);
    fs.writeFileSync(`${a.arquivo}.pid`, `${intruso.pid}\n`);
    // o banco precisa existir para o servidor chegar à etapa do .pid; um servidor anterior o cria
    const prep = await iniciar(a.arquivo + '.prep'); assert.ok(await pronto(prep)); await matar(prep);
    fs.copyFileSync(a.arquivo + '.prep', a.arquivo);
    const um = await iniciar(a.arquivo);
    const fim = await ate(um, 8000);
    assert.ok(fim && fim.code !== 0, `deveria recusar: ${JSON.stringify(fim)}\n${um.saida}`);
    assert.strictEqual(pidDe(a.arquivo), String(intruso.pid), 'o .pid do outro processo não foi apagado');
    intruso.kill();
    await dorme(300);
    fs.writeFileSync(`${a.arquivo}.pid`, '2147483646\n');
    const dois = await iniciar(a.arquivo);
    assert.ok(await pronto(dois), dois.saida);
    assert.strictEqual(pidDe(a.arquivo), String(dois.child.pid));
    await matar(dois);
  } finally { intruso.kill(); a.limpar(); }
});

for (const nome of process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM']) {
  test(`${nome}: fecha com checkpoint, remove o .pid e deixa o -wal vazio ou ausente`, async () => {
    const a = ambiente();
    try {
      const o = await iniciar(a.arquivo);
      assert.ok(await pronto(o), o.saida);
      await criarEmpresas(o, 30);
      assert.ok(tamanho(`${a.arquivo}-wal`) > 0, 'há dados no WAL antes do sinal (senão o teste não prova nada)');
      sinal(o, nome);
      const fim = await ate(o, 15000);
      assert.ok(fim, `não encerrou em 15 s\n${o.saida}`);
      assert.strictEqual(fim.code, 0, o.saida);
      assert.strictEqual(pidDe(a.arquivo), null, '.pid removido');
      assert.strictEqual(tamanho(`${a.arquivo}-wal`), 0, '-wal vazio ou ausente');
      assert.strictEqual(contarEmpresas(a.arquivo), 30, 'tudo está no arquivo principal');
    } finally { a.limpar(); }
  });
}

test('desligamento com requisição em andamento: termina dentro do prazo e o .pid sai', async () => {
  const a = ambiente();
  try {
    const o = await iniciar(a.arquivo);
    assert.ok(await pronto(o), o.saida);
    // corpo enviado devagar: a requisição fica aberta durante o sinal
    const lenta = new Promise((resolve) => {
      const r = http.request({ port: o.porta, path: '/empresas', method: 'POST', headers: { ...AUTH, 'content-length': 30 } }, (x) => { x.resume(); x.on('end', () => resolve(x.statusCode)); });
      r.on('error', (e) => resolve(`erro:${e.code}`));
      r.write('{"nome":');
      setTimeout(() => r.end('"lenta-xxxxxxxxxxxxxx"}'.slice(0, 22)), 1500);
    });
    await dorme(300);
    const t0 = Date.now();
    sinal(o, 'SIGINT');
    const fim = await ate(o, 20000);
    assert.ok(fim, `não encerrou em 20 s com requisição aberta\n${o.saida}`);
    assert.ok(Date.now() - t0 < 20000);
    assert.strictEqual(pidDe(a.arquivo), null);
    assert.ok(await Promise.race([lenta, dorme(2000).then(() => 'pendente')]) !== 'pendente', 'o cliente não ficou pendurado');
  } finally { a.limpar(); }
});

test('restauração com .pid: recusa com o servidor ligado, e funciona depois do desligamento limpo e com .pid velho', async () => {
  const a = ambiente();
  try {
    const o = await iniciar(a.arquivo);
    assert.ok(await pronto(o), o.saida);
    await criarEmpresas(o, 3);
    const { pasta } = await fazerBackup({ arquivo: a.arquivo, dir: path.join(a.raiz, 'bkp') }); // backup com o servidor ligado
    await criarEmpresas(o, 2);
    assert.throws(() => restaurar({ copia: pasta, destino: a.arquivo }), /parece estar rodando|em uso/);
    assert.strictEqual(contarEmpresas(a.arquivo), 5, 'nada foi alterado');
    sinal(o, 'SIGINT');
    assert.ok(await ate(o, 15000), o.saida);
    restaurar({ copia: pasta, destino: a.arquivo });
    assert.strictEqual(contarEmpresas(a.arquivo), 3);
    // servidor sobe sobre o arquivo restaurado e depois cai com kill -9: o .pid velho não impede nova restauração
    const dois = await iniciar(a.arquivo);
    assert.ok(await pronto(dois), dois.saida);
    await matar(dois);
    assert.ok(pidDe(a.arquivo), '.pid velho ficou');
    restaurar({ copia: pasta, destino: a.arquivo, agoraMs: Date.now() + 1000 });
    assert.strictEqual(contarEmpresas(a.arquivo), 3);
  } finally { a.limpar(); }
});

test('O1: .pid velho com o PID do próprio processo é assumido', async () => {
  const { pathToFileURL } = require('node:url');
  const { reservarPidSqlite } = await import(pathToFileURL(path.join(RAIZ, 'src', 'node', 'pid-sqlite.js')).href);
  const a = ambiente();
  try {
    fs.writeFileSync(`${a.arquivo}.pid`, `${process.pid}
`);
    const liberar = reservarPidSqlite(a.arquivo);
    liberar();
    assert.strictEqual(pidDe(a.arquivo), null);
  } finally { a.limpar(); }
});

test('O2: prazo e segundo sinal encerram requisição pendurada e fazem checkpoint', async () => {
  for (const segundoSinal of [false, true]) {
    const a = ambiente();
    let o;
    let pendente;
    try {
      o = await iniciar(a.arquivo, { CHATFLOW_DESLIGAR_MS: segundoSinal ? '10000' : '300' });
      assert.ok(await pronto(o), o.saida);
      await criarEmpresas(o, 1);
      assert.ok(tamanho(`${a.arquivo}-wal`) > 0);
      pendente = http.request({ port: o.porta, path: '/empresas', method: 'POST', headers: { ...AUTH, 'content-length': 100 } });
      pendente.on('error', () => {});
      pendente.write('{"nome":');
      await dorme(300);
      sinal(o, 'SIGINT');
      if (segundoSinal) {
        await dorme(100);
        sinal(o, 'SIGTERM');
      }
      const fim = await ate(o, 5000);
      assert.ok(fim, `deveria encerrar mesmo com a requisição aberta\n${o.saida}`);
      assert.strictEqual(fim.code, 1, o.saida);
      assert.match(o.saida, segundoSinal ? /segundo sinal/ : /prazo de desligamento/);
      assert.strictEqual(pidDe(a.arquivo), null);
      assert.strictEqual(tamanho(`${a.arquivo}-wal`), 0);
      assert.strictEqual(contarEmpresas(a.arquivo), 1);
    } finally {
      pendente?.destroy();
      if (o) await matar(o);
      a.limpar();
    }
  }
});// ---- Correções O1 e O2 da revisão (docs/revisao-operacao-sqlite.md) ----

const PRE_PID = require('node:url').pathToFileURL(path.join(__dirname, 'auxiliar', 'pid-proprio.mjs')).href;
async function iniciarComPidVelho(arquivo, valor, extra = {}) {
  const p = await porta();
  const env = { ...process.env, CHATFLOW_BANCO: 'sqlite', CHATFLOW_BANCO_ARQUIVO: arquivo, PORT: String(p), CHATFLOW_TOKEN_INTEGRACAO: 'ti-op', TESTE_PID_VELHO: String(valor), ...extra };
  const child = spawn(process.execPath, ['--import', PRE, '--import', PRE_PID, 'src/server.js'], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const o = { child, porta: p, saida: '', encerrou: null };
  child.stdout.on('data', (c) => { o.saida += c; });
  child.stderr.on('data', (c) => { o.saida += c; });
  o.fim = new Promise((r) => child.on('exit', (code, s) => { o.encerrou = { code, sinal: s }; r(o.encerrou); }));
  filhos.push(o);
  return o;
}

test('O1: .pid velho com o PID do próprio processo (contêiner reiniciado depois de queda) é assumido', async () => {
  const a = ambiente();
  try {
    const o = await iniciarComPidVelho(a.arquivo, 'proprio');
    assert.ok(await pronto(o), `o servidor deveria subir
${o.saida}`);
    assert.strictEqual(pidDe(a.arquivo), String(o.child.pid));
    sinal(o, 'SIGINT');
    assert.strictEqual((await ate(o, 10000)).code, 0);
    assert.strictEqual(pidDe(a.arquivo), null);
  } finally { a.limpar(); }
});

test('O1: simulação do ciclo do contêiner: sobe, kill -9, reinicia com o PID velho igual ao do novo processo, dados preservados', async () => {
  const a = ambiente();
  try {
    const um = await iniciarComPidVelho(a.arquivo, 'proprio');
    assert.ok(await pronto(um), um.saida);
    await criarEmpresas(um, 4);
    await matar(um);
    assert.strictEqual(pidDe(a.arquivo), String(um.child.pid), '.pid velho ficou depois do kill -9');
    const dois = await iniciarComPidVelho(a.arquivo, 'proprio'); // reinício: de novo o .pid traz o PID do processo que sobe
    assert.ok(await pronto(dois), dois.saida);
    assert.strictEqual((await requisitar(dois.porta, '/empresas', { headers: AUTH })).corpo.match(/"nome"/g).length, 4);
    await matar(dois);
  } finally { a.limpar(); }
});

test('O1: .pid=1 de imagem antiga: o servidor não apaga o .pid de um processo vivo que não é init; PID 1 só é assumido sob o tini (Linux)', async () => {
  const a = ambiente();
  const intruso = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await dorme(300);
    // 1) pid vivo de outro processo comum: recusa e preserva o arquivo
    const prep = await iniciar(`${a.arquivo}.prep`); assert.ok(await pronto(prep)); await matar(prep);
    fs.copyFileSync(`${a.arquivo}.prep`, a.arquivo);
    const recusado = await iniciarComPidVelho(a.arquivo, intruso.pid);
    const fim = await ate(recusado, 8000);
    assert.ok(fim && fim.code !== 0, recusado.saida);
    assert.strictEqual(pidDe(a.arquivo), String(intruso.pid), 'o .pid do processo vivo foi preservado');
    // 2) .pid=1: no Windows o PID 1 não existe (assumido); no Linux sem tini, PID 1 é um processo vivo qualquer e o servidor recusa
    //    (o caso com tini como PID 1 só existe dentro do contêiner: NÃO TESTADO neste host, sem Docker nem WSL)
    if (process.platform === 'win32') {
      const um = await iniciarComPidVelho(a.arquivo, 1);
      assert.ok(await pronto(um), um.saida);
      await matar(um);
    }
  } finally { intruso.kill(); a.limpar(); }
});

test('O2: requisição pendurada não impede o desligamento: sai no prazo, remove o .pid e deixa o -wal vazio', async () => {
  const a = ambiente();
  try {
    const o = await iniciar(a.arquivo, { CHATFLOW_DESLIGAR_MS: '1500' });
    assert.ok(await pronto(o), o.saida);
    await criarEmpresas(o, 5);
    const pendente = http.request({ port: o.porta, path: '/empresas', method: 'POST', headers: { ...AUTH, 'content-length': 100 } });
    pendente.on('error', () => {});
    pendente.write('{"nome":');
    await dorme(300);
    const t0 = Date.now();
    sinal(o, 'SIGINT');
    const fim = await ate(o, 15000);
    pendente.destroy();
    assert.ok(fim, `deveria encerrar no prazo
${o.saida}`);
    const ms = Date.now() - t0;
    assert.ok(ms >= 1000 && ms < 8000, `encerrou em ${ms} ms (prazo de 1500 ms)`);
    assert.strictEqual(pidDe(a.arquivo), null, '.pid removido');
    assert.strictEqual(tamanho(`${a.arquivo}-wal`), 0, '-wal vazio ou ausente');
    assert.strictEqual(contarEmpresas(a.arquivo), 5);
  } finally { a.limpar(); }
});

test('O2: um segundo sinal força o fechamento sem esperar o prazo', async () => {
  const a = ambiente();
  try {
    const o = await iniciar(a.arquivo, { CHATFLOW_DESLIGAR_MS: '60000' });
    assert.ok(await pronto(o), o.saida);
    const pendente = http.request({ port: o.porta, path: '/empresas', method: 'POST', headers: { ...AUTH, 'content-length': 100 } });
    pendente.on('error', () => {});
    pendente.write('{"nome":');
    await dorme(300);
    sinal(o, 'SIGINT');
    assert.strictEqual(await ate(o, 1500), null, 'o primeiro sinal espera pela requisição (prazo de 60 s)');
    const t0 = Date.now();
    sinal(o, 'SIGINT');
    const fim = await ate(o, 10000);
    pendente.destroy();
    assert.ok(fim, `o segundo sinal deveria forçar a saída
${o.saida}`);
    assert.ok(Date.now() - t0 < 8000);
    assert.strictEqual(pidDe(a.arquivo), null, '.pid removido mesmo no fechamento forçado');
  } finally { a.limpar(); }
});
