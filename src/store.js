'use strict';

function criarStore() {
  return { lojas: new Map(), reservas: [], chaves: new Map() };
}

function addLoja(store, { id, nome, agente, ambientes }) {
  store.lojas.set(id, { id, nome, agente, ambientes });
}

module.exports = { criarStore, addLoja };
