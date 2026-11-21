'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { criarRepositorioSqlite } = require('../src/sqlite/repositorio');
const { fazerBackup, listarCopias } = require('../scripts/backup-sqlite');
const { restaurar } = require('../scripts/restaurar-sqlite');
const { validarBanco } = require('../scripts/sqlite-util');

const empresa = (id) => ({ id, nome: `Empresa ${id}`, agente: {}, ambientes: [{ nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] }] });
const nomes = (arquivo) => {
  const db = new DatabaseSync(arquivo, { readOnly: true });
  try { return db.prepare('SELECT id FROM empresas ORDER BY id').all().map((r) => r.id); } finally { db.close(); }
};

// Produção usa WAL (pedido ao T04); os testes de bloqueio dependem dele.
async function ambiente() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'chatflow-bkp-'));
  const arquivo = path.join(raiz, 'dados', 'chatflow.sqlite');
  fs.mkdirSync(path.dirname(arquivo));
  const repo = criarRepositorioSqlite({ caminho: arquivo });
  await repo.empresaCriar(empresa('e1'));
  const w = new DatabaseSync(arquivo); w.exec('PRAGMA journal_mode = WAL'); w.close();
  return { raiz, arquivo, dir: path.join(raiz, 'backups'), repo, limpar: () => fs.rmSync(raiz, { recursive: true, force: true }) };
}

test('backup com o banco aberto e em uso: cópia consistente, verificada e com checksum', async () => {
  const a = await ambiente();
  try {
    a.repo.plat; // servidor segue aberto durante o backup
    const r = await fazerBackup({ arquivo: a.arquivo, dir: a.dir, manter: 5, agoraMs: Date.UTC(2026, 10, 21, 10, 0, 0) });
    assert.match(r.pasta, /2026-11-21T10-00-00-000Z$/);
    const copia = path.join(r.pasta, 'chatflow.sqlite');
    assert.deepStrictEqual(nomes(copia), ['e1']);
    assert.deepStrictEqual(validarBanco(copia), { ok: true });
    assert.match(fs.readFileSync(`${copia}.sha256`, 'utf8'), /^[0-9a-f]{64} {2}chatflow\.sqlite\n$/);
    assert.deepStrictEqual(fs.readdirSync(a.dir), ['2026-11-21T10-00-00-000Z'], 'nada de pasta .parcial sobrando');
    // o servidor continua gravando depois do backup
    await a.repo.empresaCriar(empresa('e2'));
    assert.deepStrictEqual(nomes(copia), ['e1']);
  } finally { await a.repo.fechar(); a.limpar(); }
});

test('rotação: mantém só as N últimas e ignora pastas que não são cópias', async () => {
  const a = await ambiente();
  try {
    fs.mkdirSync(a.dir);
    fs.mkdirSync(path.join(a.dir, 'minhas-notas'));
    for (let h = 0; h < 5; h++) await fazerBackup({ arquivo: a.arquivo, dir: a.dir, manter: 3, agoraMs: Date.UTC(2026, 10, 21, h) });
    assert.deepStrictEqual(listarCopias(a.dir), ['2026-11-21T02-00-00-000Z', '2026-11-21T03-00-00-000Z', '2026-11-21T04-00-00-000Z']);
    assert.ok(fs.existsSync(path.join(a.dir, 'minhas-notas')));
    await assert.rejects(() => fazerBackup({ arquivo: a.arquivo, dir: a.dir, manter: 0 }), /MANTER/);
  } finally { await a.repo.fechar(); a.limpar(); }
});

test('backup de arquivo inexistente falha e não deixa pasta', async () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'chatflow-bkp-'));
  try {
    await assert.rejects(() => fazerBackup({ arquivo: path.join(raiz, 'nao.sqlite'), dir: path.join(raiz, 'b') }), /não encontrado/);
    assert.ok(!fs.existsSync(path.join(raiz, 'b')));
  } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});

test('restauração: volta ao estado da cópia e guarda o arquivo atual como .antes-restauracao', async () => {
  const a = await ambiente();
  try {
    const { pasta } = await fazerBackup({ arquivo: a.arquivo, dir: a.dir });
    await a.repo.empresaCriar(empresa('e2'));
    await a.repo.fechar(); // servidor parado
    const r = restaurar({ copia: pasta, destino: a.arquivo });
    assert.deepStrictEqual(nomes(a.arquivo), ['e1']);
    assert.strictEqual(r.guardado, `${a.arquivo}.antes-restauracao`);
    assert.deepStrictEqual(nomes(r.guardado), ['e1', 'e2'], 'o estado anterior não se perdeu');
    assert.deepStrictEqual(validarBanco(a.arquivo), { ok: true });
    // uma segunda restauração não sobrescreve o arquivo guardado
    const r2 = restaurar({ copia: pasta, destino: a.arquivo, agoraMs: Date.UTC(2026, 10, 22) });
    assert.notStrictEqual(r2.guardado, r.guardado);
    assert.deepStrictEqual(nomes(r.guardado), ['e1', 'e2']);
    // o repositório abre o arquivo restaurado e continua funcionando
    const repo = criarRepositorioSqlite({ caminho: a.arquivo });
    assert.strictEqual((await repo.empresaListar()).length, 1);
    await repo.fechar();
  } finally { a.limpar(); }
});

test('restauração recusa cópia corrompida sem tocar no banco atual', async () => {
  const a = await ambiente();
  try {
    const { pasta } = await fazerBackup({ arquivo: a.arquivo, dir: a.dir });
    await a.repo.fechar();
    const copia = path.join(pasta, 'chatflow.sqlite');
    const bytes = fs.readFileSync(copia);
    fs.writeFileSync(copia, Buffer.concat([bytes.subarray(0, 4096), Buffer.alloc(bytes.length - 4096, 0xab)]));
    const antes = fs.readFileSync(a.arquivo);
    assert.throws(() => restaurar({ copia: pasta, destino: a.arquivo }), /inválida|malformed|not a database|NÃO foi usada/);
    assert.ok(antes.equals(fs.readFileSync(a.arquivo)));
    assert.ok(!fs.existsSync(`${a.arquivo}.antes-restauracao`));
    assert.throws(() => restaurar({ copia: path.join(a.raiz, 'nao-existe'), destino: a.arquivo }), /não encontrada/);
    // um SQLite válido que não é do ChatFlow também é recusado
    const outro = path.join(a.raiz, 'outro.sqlite');
    const o = new DatabaseSync(outro); o.exec('CREATE TABLE x (a)'); o.close();
    assert.throws(() => restaurar({ copia: outro, destino: a.arquivo }), /não parece um banco do ChatFlow/);
  } finally { a.limpar(); }
});

test('restauração recusa rodar com o servidor aberto (banco bloqueado) e não altera nada', async () => {
  const a = await ambiente();
  try {
    const { pasta } = await fazerBackup({ arquivo: a.arquivo, dir: a.dir });
    // `a.repo` é o servidor ainda aberto; uma transação de escrita em curso também conta como uso
    const escritor = new DatabaseSync(a.arquivo);
    escritor.exec('BEGIN IMMEDIATE');
    assert.throws(() => restaurar({ copia: pasta, destino: a.arquivo }), /em uso/);
    escritor.exec('ROLLBACK'); escritor.close();
    assert.throws(() => restaurar({ copia: pasta, destino: a.arquivo }), /em uso/, 'conexão aberta do servidor, mesmo ociosa (WAL)');
    assert.deepStrictEqual(nomes(a.arquivo), ['e1']);
    assert.ok(!fs.existsSync(`${a.arquivo}.antes-restauracao`));
    assert.ok(!fs.existsSync(`${a.arquivo}.restaurando`));
  } finally { await a.repo.fechar(); a.limpar(); }
});

test('restauração recusa quando o arquivo .pid aponta para um processo vivo, e ignora PID morto', async () => {
  const a = await ambiente();
  try {
    const { pasta } = await fazerBackup({ arquivo: a.arquivo, dir: a.dir });
    await a.repo.fechar();
    fs.writeFileSync(`${a.arquivo}.pid`, String(process.ppid)); // processo pai: vivo
    assert.throws(() => restaurar({ copia: pasta, destino: a.arquivo }), /parece estar rodando/);
    fs.writeFileSync(`${a.arquivo}.pid`, '2147483646'); // não existe
    assert.doesNotThrow(() => restaurar({ copia: pasta, destino: a.arquivo }));
  } finally { a.limpar(); }
});

const doc = (n) => ({ tipo: 'documento', titulo: `doc ${n}`, arquivo: { nome: `${n}.txt`, mime: 'text/plain', tamanho: 5, base64: Buffer.from(`ola-${n}`).toString('base64') } });
const anexos = (arquivo) => (fs.existsSync(`${arquivo}.arquivos`) ? fs.readdirSync(`${arquivo}.arquivos`).sort() : []);

test('anexos do conhecimento: backup copia a pasta junto, restauração a devolve e guarda a atual', async () => {
  const a = await ambiente();
  try {
    await a.repo.conhecimentoCriar('e1', doc(1), 200);
    await a.repo.conhecimentoCriar('e1', doc(2), 200);
    const r = await fazerBackup({ arquivo: a.arquivo, dir: a.dir });
    assert.strictEqual(r.anexos, 2);
    assert.deepStrictEqual(r.orfaos, []);
    assert.deepStrictEqual(fs.readdirSync(path.join(r.pasta, 'arquivos')).sort(), anexos(a.arquivo));
    // depois do backup: um anexo novo e um apagado
    await a.repo.conhecimentoCriar('e1', doc(3), 200);
    await a.repo.conhecimentoExcluir('e1', 1);
    const noServidor = anexos(a.arquivo);
    await a.repo.fechar();
    const res = restaurar({ copia: r.pasta, destino: a.arquivo });
    assert.strictEqual(anexos(a.arquivo).length, 2);
    assert.deepStrictEqual(anexos(a.arquivo), fs.readdirSync(path.join(r.pasta, 'arquivos')).sort());
    assert.deepStrictEqual(fs.readdirSync(res.pastaGuardada).sort(), noServidor, 'a pasta anterior ficou inteira em .antes-restauracao');
    const repo = criarRepositorioSqlite({ caminho: a.arquivo });
    const itens = await repo.conhecimentoListar('e1');
    assert.strictEqual(itens.length, 2);
    await repo.fechar();
  } finally { a.limpar(); }
});

test('anexos: órfão é copiado e avisado; anexo referenciado que sumiu faz o backup falhar', async () => {
  const a = await ambiente();
  try {
    await a.repo.conhecimentoCriar('e1', doc(1), 200);
    fs.writeFileSync(path.join(`${a.arquivo}.arquivos`, '00000000-0000-0000-0000-000000000000'), 'sobra');
    const r = await fazerBackup({ arquivo: a.arquivo, dir: a.dir });
    assert.deepStrictEqual(r.orfaos, ['00000000-0000-0000-0000-000000000000']);
    const [ref] = anexos(a.arquivo).filter((n) => n !== r.orfaos[0]);
    fs.rmSync(path.join(`${a.arquivo}.arquivos`, ref));
    await assert.rejects(() => fazerBackup({ arquivo: a.arquivo, dir: a.dir, agoraMs: Date.now() + 1000 }), /não existem na pasta/);
    assert.deepStrictEqual(listarCopias(a.dir).length, 1, 'a cópia incompleta não ficou, e a boa não foi apagada');
    assert.ok(!fs.readdirSync(a.dir).some((n) => n.endsWith('.parcial')));
  } finally { await a.repo.fechar(); a.limpar(); }
});

test('anexos: restauração recusa cópia a que falta anexo e não toca em nada', async () => {
  const a = await ambiente();
  try {
    await a.repo.conhecimentoCriar('e1', doc(1), 200);
    const { pasta } = await fazerBackup({ arquivo: a.arquivo, dir: a.dir });
    await a.repo.fechar();
    for (const n of fs.readdirSync(path.join(pasta, 'arquivos'))) fs.rmSync(path.join(pasta, 'arquivos', n));
    const antes = anexos(a.arquivo);
    assert.throws(() => restaurar({ copia: pasta, destino: a.arquivo }), /NÃO foi usada.*anexo/);
    assert.deepStrictEqual(anexos(a.arquivo), antes);
    assert.ok(!fs.existsSync(`${a.arquivo}.antes-restauracao`));
    assert.ok(!fs.existsSync(`${a.arquivo}.arquivos.restaurando`));
  } finally { a.limpar(); }
});
