'use strict';

const CAMPOS = ['descricao', 'habilidades', 'produtos', 'restricoes'];

function loja(store, id) {
  const l = store.lojas.get(id);
  if (!l) {
    const e = new Error('loja inexistente');
    e.codigo = 404;
    throw e;
  }
  return l;
}

// Leitura somente leitura: devolve o bloco inteiro da loja.
function lerConfig(store, lojaId) {
  const a = loja(store, lojaId).agente;
  return JSON.parse(JSON.stringify({
    descricao: a.descricao,
    habilidades: a.habilidades,
    produtos: a.produtos,
    restricoes: a.restricoes,
  }));
}

// agente.editavelPor: { campo: ['cliente', 'integracao'] }; padrão: só integração.
function atualizar(store, lojaId, campo, valor, papel) {
  const a = loja(store, lojaId).agente;
  if (!CAMPOS.includes(campo)) throw new Error('campo inválido');
  const permitidos = (a.editavelPor && a.editavelPor[campo]) || ['integracao'];
  if (!permitidos.includes(papel)) {
    const e = new Error('sem permissão');
    e.codigo = 403;
    throw e;
  }
  a[campo] = valor;
}

module.exports = { lerConfig, atualizar, loja };
