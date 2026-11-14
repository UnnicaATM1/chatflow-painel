'use strict';

function criarStore() {
  return { empresas: new Map(), reservas: [], chaves: new Map(), historico: [], historicoArquivo: process.env.KENDJI_HISTORICO_ARQUIVO || null };
}

function addEmpresa(store, { id, nome, agente, ambientes }) {
  store.empresas.set(id, { id, nome, agente, ambientes, chave: null });
}

module.exports = { criarStore, addEmpresa };
