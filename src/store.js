'use strict';

import { plataformaWeb } from './plataforma.js';

// opcoes.plat: plataforma (padrão: Web API). opcoes.sink: função chamada com cada evento de histórico gravado (o adaptador Node
// usa para gravar em arquivo); o núcleo só chama sink(evento).
function criarStore({ plat, sink } = {}) {
  const p = plat || plataformaWeb();
  return { plat: p, sink: sink || null, boot: p.uuid(), empresas: new Map(), reservas: [], chaves: new Map(), historico: [] };
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
