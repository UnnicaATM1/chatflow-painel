'use strict';

function criarStore() {
  return { lojas: new Map(), reservas: [], chaves: new Map(), historico: [], historicoArquivo: process.env.KENDJI_HISTORICO_ARQUIVO || null };
}

function addLoja(store, { id, nome, agente, ambientes }) {
  store.lojas.set(id, { id, nome, agente, ambientes });
}

module.exports = { criarStore, addLoja };
