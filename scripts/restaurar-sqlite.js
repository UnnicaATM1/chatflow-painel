'use strict';

// Restaura uma cópia do banco SQLite do ChatFlow Painel. PARE O SERVIDOR ANTES.
//   node scripts/restaurar-sqlite.js <pasta-da-copia | arquivo.sqlite> [--forcar]
// Restaura também os anexos do conhecimento (<copia>/arquivos -> <destino>.arquivos), guardando a pasta atual como
// <destino>.arquivos.antes-restauracao. Cópia cujo banco referencia anexo que não está na pasta é recusada.
// Destino: CHATFLOW_BANCO_ARQUIVO (padrão chatflow.sqlite). Antes de trocar, valida a cópia e confere se alguém
// está com o banco aberto (recusa se estiver). O arquivo atual é guardado como <destino>.antes-restauracao.
// --forcar: só para o caso de haver -wal/-shm sem o arquivo do banco ao lado; nunca ignora bloqueio nem PID vivo.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { NOME_COPIA, PASTA_ANEXOS, validarBanco, carimbo, conferirAnexos, copiarAnexos } = require('./sqlite-util');

function erro(msg) { return new Error(msg); }

// O servidor deve gravar <banco>.pid com o seu PID ao subir (pedido ao T04). Se o processo existe, é servidor ligado.
function conferirPid(destino) {
  let pid;
  try { pid = Number(fs.readFileSync(`${destino}.pid`, 'utf8').trim()); } catch { return; }
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) return;
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return; /* EPERM: existe */ }
  throw erro(`o servidor parece estar rodando (PID ${pid} em ${destino}.pid). Pare-o e tente de novo.`);
}

// Tenta ficar sozinho com o banco: modo exclusivo e transação de escrita. Falha se outra conexão (servidor) o usa.
function conferirSemUso(destino) {
  let db;
  try {
    db = new DatabaseSync(destino);
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('SELECT count(*) FROM sqlite_master').get(); // força a obtenção do bloqueio exclusivo
    db.exec('ROLLBACK');
  } catch (e) {
    if (db) try { db.close(); } catch { /* ignora */ }
    if (/locked|busy/i.test(e.message)) throw erro('o banco está em uso (bloqueado). Pare o servidor e tente de novo.');
    throw erro(`não foi possível examinar o banco atual: ${e.message}`);
  }
  try { db.close(); } catch { /* ignora */ }
}

function arquivoDaCopia(origem) {
  if (!fs.existsSync(origem)) throw erro(`cópia não encontrada: ${origem}`);
  return fs.statSync(origem).isDirectory() ? path.join(origem, NOME_COPIA) : origem;
}

function restaurar({ copia, destino, forcar = false, agoraMs = Date.now() } = {}) {
  const fonte = arquivoDaCopia(copia);
  if (path.resolve(fonte) === path.resolve(destino)) throw erro('a cópia e o destino são o mesmo arquivo');
  const v = validarBanco(fonte);
  if (!v.ok) throw erro(`a cópia é inválida e NÃO foi usada: ${v.motivo}`);

  const pastaCopia = fs.statSync(copia).isDirectory() ? path.join(copia, PASTA_ANEXOS) : `${fonte}.arquivos`;
  const anexos = conferirAnexos(fonte, pastaCopia);
  if (anexos.faltando.length) throw erro(`a cópia é inválida e NÃO foi usada: ${anexos.faltando.length} anexo(s) referenciado(s) não existem em ${pastaCopia} (ex.: ${anexos.faltando.slice(0, 3).join(', ')})`);

  const existe = fs.existsSync(destino);
  const sobras = ['-wal', '-shm'].filter((s) => fs.existsSync(destino + s));
  conferirPid(destino);
  if (existe) {
    // Se -wal ou -shm existem, ou o servidor está rodando, ou caiu sem fechar. O teste de bloqueio decide o primeiro caso.
    conferirSemUso(destino);
    // Passou o teste acima: ninguém usa o banco e qualquer -wal pendente já foi aplicado. O que sobrar é inofensivo e sai do caminho abaixo.
  } else if (sobras.length && !forcar) {
    throw erro(`existem ${sobras.join(' e ')} sem o banco ao lado; confira e rode com --forcar`);
  }

  fs.mkdirSync(path.dirname(path.resolve(destino)), { recursive: true });
  const novo = `${destino}.restaurando`;
  fs.copyFileSync(fonte, novo);
  const v2 = validarBanco(novo);
  if (!v2.ok) { fs.rmSync(novo, { force: true }); throw erro(`a cópia ficou inválida ao ser copiada: ${v2.motivo}`); }

  // Anexos: prepara a pasta nova ao lado, antes de mexer em qualquer coisa que já existe.
  const pastaDestino = `${destino}.arquivos`;
  const pastaNova = `${pastaDestino}.restaurando`;
  fs.rmSync(pastaNova, { recursive: true, force: true });
  if (fs.existsSync(pastaCopia)) copiarAnexos(pastaCopia, pastaNova);

  let guardado = null;
  let pastaGuardada = null;
  if (existe) {
    guardado = `${destino}.antes-restauracao`;
    if (fs.existsSync(guardado)) guardado = `${guardado}-${carimbo(agoraMs)}`; // nunca sobrescreve um guardado anterior
    try { fs.renameSync(destino, guardado); } catch (e) {
      fs.rmSync(novo, { force: true });
      if (e.code === 'EBUSY' || e.code === 'EPERM') throw erro('o banco está em uso (bloqueado). Pare o servidor e tente de novo.');
      throw e;
    }
  }
  // Um -wal/-shm antigo aplicado sobre o arquivo restaurado o corromperia: sai de perto junto com o arquivo antigo.
  for (const s of ['-wal', '-shm']) {
    if (fs.existsSync(destino + s)) fs.renameSync(destino + s, `${guardado || destino + '.antes-restauracao'}${s}`);
  }
  try {
    if (fs.existsSync(pastaDestino)) {
      pastaGuardada = `${pastaDestino}.antes-restauracao`;
      if (fs.existsSync(pastaGuardada)) pastaGuardada = `${pastaGuardada}-${carimbo(agoraMs)}`;
      fs.renameSync(pastaDestino, pastaGuardada);
    }
    if (fs.existsSync(pastaNova)) fs.renameSync(pastaNova, pastaDestino);
  } catch (e) {
    // desfaz tudo: o banco novo ainda não entrou no lugar, então o antigo (com -wal/-shm) volta
    if (guardado) {
      fs.renameSync(guardado, destino);
      for (const sfx of ['-wal', '-shm']) if (fs.existsSync(`${guardado}${sfx}`)) fs.renameSync(`${guardado}${sfx}`, destino + sfx);
    }
    if (pastaGuardada && !fs.existsSync(pastaDestino)) fs.renameSync(pastaGuardada, pastaDestino);
    fs.rmSync(pastaNova, { recursive: true, force: true });
    throw erro(`não foi possível trocar a pasta de anexos: ${e.message}`);
  }
  fs.renameSync(novo, destino);
  return { destino, fonte, guardado, pastaGuardada, anexos: anexos.referenciados, orfaos: anexos.orfaos };
}

module.exports = { restaurar, conferirSemUso };

if (require.main === module) {
  const args = process.argv.slice(2);
  const forcar = args.includes('--forcar');
  const copia = args.find((a) => !a.startsWith('--'));
  if (!copia) {
    console.error('uso: node scripts/restaurar-sqlite.js <pasta-da-copia | arquivo.sqlite> [--forcar]');
    process.exitCode = 2;
  } else {
    try {
      const r = restaurar({ copia, destino: process.env.CHATFLOW_BANCO_ARQUIVO || 'chatflow.sqlite', forcar });
      console.log(`restaurado: ${r.fonte} -> ${r.destino}`);
      if (r.guardado) console.log(`o arquivo anterior foi guardado em ${r.guardado}`);
      console.log(`anexos do conhecimento: ${r.anexos} referenciado(s), todos restaurados`);
      if (r.pastaGuardada) console.log(`a pasta de anexos anterior foi guardada em ${r.pastaGuardada}`);
      if (r.orfaos.length) console.warn(`AVISO: ${r.orfaos.length} anexo(s) órfão(s) (sem linha no banco) foram restaurados junto`);
    } catch (e) {
      console.error(`restauração RECUSADA: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
