'use strict';

// Histórico de modificações: só acrescenta (append-only). Não existe função para alterar ou apagar eventos.
// Cada evento registra quem (papel do token + operador informado), quando, o quê e antes/depois.
const fs = require('node:fs');
const crypto = require('node:crypto');

const BOOT = crypto.randomUUID();

function congelar(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(congelar); Object.freeze(o); }
  return o;
}

function registrar(store, ev) {
  const e = congelar({ seq: store.historico.length + 1, boot: BOOT, quando: new Date().toISOString(), ...JSON.parse(JSON.stringify(ev)) });
  store.historico.push(e);
  if (store.historicoArquivo) {
    try { fs.appendFileSync(store.historicoArquivo, JSON.stringify(e) + '\n', 'utf8'); }
    catch (err) { console.error('falha ao gravar histórico em arquivo:', err.message); }
  }
  return e;
}

// Só os campos que mudaram, com valor antes e depois.
function diff(antes, depois) {
  const a = {}, d = {};
  for (const k of new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})])) {
    if (JSON.stringify((antes || {})[k]) !== JSON.stringify((depois || {})[k])) { a[k] = (antes || {})[k]; d[k] = (depois || {})[k]; }
  }
  return { antes: a, depois: d };
}

function listar(store, empresaId, { entidade, entidadeId, limite } = {}) {
  const n = Math.min(Math.max(Number(limite) || 200, 1), 1000);
  return store.historico
    .filter((e) => e.empresaId === empresaId && (!entidade || e.entidade === entidade) && (!entidadeId || String(e.entidadeId) === String(entidadeId)))
    .slice(-n)
    .reverse();
}

module.exports = { registrar, diff, listar };
