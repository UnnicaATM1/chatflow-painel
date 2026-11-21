'use strict';

// Backup consistente do banco SQLite do ChatFlow Painel, com o servidor ligado.
//   node scripts/backup-sqlite.js
// Variáveis: CHATFLOW_BANCO_ARQUIVO (padrão chatflow.sqlite), CHATFLOW_BACKUP_DIR (padrão ./backups),
//            CHATFLOW_BACKUP_MANTER (quantas cópias guardar, padrão 14).
// Grava backups/<carimbo UTC>/chatflow.sqlite (+ .sha256) e arquivos/ (anexos do conhecimento, de <banco>.arquivos/),
// confere a cópia e só então apaga as mais antigas. Os anexos são copiados DEPOIS do snapshot do banco e todo anexo
// referenciado precisa existir na cópia (se o servidor apagou um no meio, refaz até 3 vezes); anexos sem linha são
// avisados (órfãos) e copiados mesmo assim.
// Saída com código 1 se algo falhar (nesse caso nenhuma cópia antiga é apagada).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite = require('node:sqlite');
const { NOME_COPIA, PASTA_ANEXOS, validarBanco, carimbo, PADRAO_PASTA, conferirAnexos, copiarAnexos } = require('./sqlite-util');

const MANTER_PADRAO = 14;

function sha256(arquivo) { return crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex'); }

// Copia o banco em uso. Usa a API de backup do node:sqlite (copia páginas com o banco aberto e consistente);
// se a versão do Node não tiver, cai para VACUUM INTO (também consistente).
async function copiar(origem, destino) {
  const db = new sqlite.DatabaseSync(origem);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (typeof sqlite.backup === 'function') {
      await sqlite.backup(db, destino);
      return 'backup';
    }
    db.prepare('VACUUM INTO ?').run(destino);
    return 'vacuum-into';
  } finally {
    db.close();
  }
}

function listarCopias(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && PADRAO_PASTA.test(d.name)).map((d) => d.name).sort();
}

// Apaga as cópias mais antigas e devolve os nomes removidos. Só mexe em pastas com nome de carimbo.
function rotacionar(dir, manter) {
  const todas = listarCopias(dir);
  const sobra = todas.slice(0, Math.max(0, todas.length - manter));
  for (const nome of sobra) fs.rmSync(path.join(dir, nome), { recursive: true, force: true });
  return sobra;
}

async function fazerBackup({ arquivo, dir, manter = MANTER_PADRAO, agoraMs = Date.now() } = {}) {
  if (!Number.isInteger(manter) || manter < 1) throw new Error('CHATFLOW_BACKUP_MANTER deve ser um inteiro maior que zero');
  if (!arquivo || !fs.existsSync(arquivo)) throw new Error(`banco não encontrado: ${arquivo}`);
  if (path.resolve(dir).startsWith(path.resolve(arquivo))) throw new Error('a pasta de backup não pode ficar dentro do arquivo do banco');
  const nome = carimbo(agoraMs);
  const pasta = path.join(dir, nome);
  const parcial = `${pasta}.parcial`;
  fs.mkdirSync(parcial, { recursive: true });
  try {
    const alvo = path.join(parcial, NOME_COPIA);
    const pastaAnexos = path.join(parcial, PASTA_ANEXOS);
    let metodo, conf, tentativa = 0;
    for (;;) {
      tentativa++;
      fs.rmSync(alvo, { force: true });
      fs.rmSync(pastaAnexos, { recursive: true, force: true });
      metodo = await copiar(arquivo, alvo);
      // A cópia é só um arquivo: tira o modo WAL dela para não gerar -wal/-shm ao lado quando for aberta (o servidor religa o WAL ao subir).
      const c = new sqlite.DatabaseSync(alvo);
      try { c.exec('PRAGMA journal_mode = DELETE'); } finally { c.close(); }
      const v = validarBanco(alvo);
      if (!v.ok) throw new Error(`a cópia não passou na verificação: ${v.motivo}`);
      if (fs.existsSync(`${arquivo}.arquivos`)) copiarAnexos(`${arquivo}.arquivos`, pastaAnexos); // depois do snapshot
      conf = conferirAnexos(alvo, pastaAnexos);
      if (!conf.faltando.length) break;
      if (tentativa >= 3) throw new Error(`${conf.faltando.length} anexo(s) referenciado(s) não existem na pasta ${arquivo}.arquivos (ex.: ${conf.faltando.slice(0, 3).join(', ')}): o banco aponta para arquivo perdido`);
    }
    fs.writeFileSync(`${alvo}.sha256`, `${sha256(alvo)}  ${NOME_COPIA}\n`);
    fs.renameSync(parcial, pasta); // só vira "cópia" depois de verificada e completa
    const removidas = rotacionar(dir, manter);
    return { pasta, metodo, bytes: fs.statSync(path.join(pasta, NOME_COPIA)).size, anexos: conf.referenciados, orfaos: conf.orfaos, removidas };
  } catch (erro) {
    fs.rmSync(parcial, { recursive: true, force: true });
    throw erro;
  }
}

module.exports = { fazerBackup, rotacionar, listarCopias, MANTER_PADRAO };

if (require.main === module) {
  const manter = process.env.CHATFLOW_BACKUP_MANTER === undefined ? MANTER_PADRAO : Number(process.env.CHATFLOW_BACKUP_MANTER);
  fazerBackup({
    arquivo: process.env.CHATFLOW_BANCO_ARQUIVO || 'chatflow.sqlite',
    dir: process.env.CHATFLOW_BACKUP_DIR || 'backups',
    manter,
  }).then((r) => {
    console.log(`backup ok (${r.metodo}): ${r.pasta} (${r.bytes} bytes); verificação integrity_check e foreign_key_check ok`);
    console.log(`anexos do conhecimento: ${r.anexos} referenciado(s), todos presentes na cópia`);
    if (r.orfaos.length) console.warn(`AVISO: ${r.orfaos.length} anexo(s) órfão(s) (sem linha no banco), copiados mesmo assim: ${r.orfaos.slice(0, 5).join(', ')}`);
    if (r.removidas.length) console.log(`rotação: ${r.removidas.length} cópia(s) antiga(s) removida(s)`);
  }).catch((erro) => {
    console.error(`backup FALHOU: ${erro.message}`);
    process.exitCode = 1;
  });
}
