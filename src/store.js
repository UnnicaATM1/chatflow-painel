'use strict';

function criarStore() {
  return { empresas: new Map(), reservas: [], chaves: new Map(), historico: [], historicoArquivo: process.env.KENDJI_HISTORICO_ARQUIVO || null };
}

// modulos: quais recursos a empresa usa (nem todo negócio tem mesas). Padrão: tudo ligado.
function addEmpresa(store, { id, nome, agente, ambientes, modulos }) {
  store.empresas.set(id, {
    id, nome, agente, ambientes, chave: null,
    modulos: { reservas: true, conhecimento: true, ...(modulos || {}) },
    conhecimento: [], proxConhecimento: 1,
  });
}

export { criarStore, addEmpresa };
