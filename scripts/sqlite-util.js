'use strict';

// Funções comuns do backup e da restauração do SQLite do ChatFlow Painel. Sem dependências além do Node 22+.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const NOME_COPIA = 'chatflow.sqlite';

// Valida um arquivo SQLite sem alterá-lo: abre só para leitura e confere integridade, chaves estrangeiras e o esquema.
// Devolve { ok: true } ou { ok: false, motivo }.
function validarBanco(arquivo) {
  let db;
  try {
    if (!fs.existsSync(arquivo)) return { ok: false, motivo: 'arquivo não existe' };
    db = new DatabaseSync(arquivo, { readOnly: true });
    const integ = db.prepare('PRAGMA integrity_check').all().map((l) => Object.values(l)[0]);
    if (integ.length !== 1 || integ[0] !== 'ok') return { ok: false, motivo: `integrity_check: ${integ.slice(0, 5).join('; ')}` };
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) return { ok: false, motivo: `foreign_key_check: ${fk.length} violação(ões), primeira na tabela ${fk[0].table}` };
    const tabelas = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    for (const t of ['empresas', 'reservas', 'historico']) {
      if (!tabelas.has(t)) return { ok: false, motivo: `não parece um banco do ChatFlow Painel (falta a tabela ${t})` };
    }
    return { ok: true };
  } catch (erro) {
    return { ok: false, motivo: erro.message };
  } finally {
    if (db) try { db.close(); } catch { /* já fechado */ }
  }
}

// Anexos do conhecimento ficam em <banco>.arquivos/<uuid> (o nome é o último trecho do arquivoChave guardado na linha).
function nomeDoAnexo(chave) { return String(chave).split('/').at(-1); }

// Nomes dos anexos que as linhas de `conhecimento` do banco referenciam.
function anexosReferenciados(arquivoBanco) {
  const db = new DatabaseSync(arquivoBanco, { readOnly: true });
  try {
    const nomes = new Set();
    for (const { item } of db.prepare('SELECT item FROM conhecimento').all()) {
      const chave = JSON.parse(item).arquivoChave;
      if (chave) nomes.add(nomeDoAnexo(chave));
    }
    return nomes;
  } finally { db.close(); }
}

function anexosNaPasta(pasta) {
  if (!fs.existsSync(pasta)) return new Set();
  return new Set(fs.readdirSync(pasta, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name));
}

// Compara referências e arquivos: { faltando: referenciados que não existem, orfaos: existem sem referência }.
function conferirAnexos(arquivoBanco, pastaAnexos) {
  const ref = anexosReferenciados(arquivoBanco);
  const tem = anexosNaPasta(pastaAnexos);
  return { faltando: [...ref].filter((n) => !tem.has(n)).sort(), orfaos: [...tem].filter((n) => !ref.has(n)).sort(), referenciados: ref.size };
}

// Copia os arquivos de uma pasta plana. Arquivo que sumir no meio (apagado pelo servidor) é ignorado.
function copiarAnexos(origem, destino) {
  fs.mkdirSync(destino, { recursive: true });
  let n = 0;
  for (const nome of anexosNaPasta(origem)) {
    try { fs.copyFileSync(path.join(origem, nome), path.join(destino, nome)); n++; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return n;
}

// Carimbo para nome de pasta: 2026-11-21T13-05-09-123Z (ordem alfabética = ordem cronológica).
function carimbo(ms) { return new Date(ms).toISOString().replace(/[:.]/g, '-'); }
const PADRAO_PASTA = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

module.exports = { NOME_COPIA, PASTA_ANEXOS: 'arquivos', validarBanco, carimbo, PADRAO_PASTA, anexosReferenciados, conferirAnexos, copiarAnexos };
