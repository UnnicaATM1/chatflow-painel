// Guarda a matriz de permissões (src/permissoes.js): quem pode o quê. Mudou a tabela de propósito? Atualize esta matriz junto.
const test = require('node:test');
const assert = require('node:assert');
const { PERMISSOES, podeFazer } = require('../src/permissoes');

const PAPEIS = ['equipe', 'admin', 'superadmin', 'cliente', 'integracao', 'chat'];
// true = pode. Colunas na ordem de PAPEIS.
const MATRIZ = {
  'painel.usar':            [1, 1, 1, 1, 1, 0],
  'historico.ver':          [0, 1, 1, 1, 1, 0],
  'historico.desfazer':     [0, 1, 1, 1, 1, 0],
  'historico.excluidas':    [0, 0, 1, 1, 1, 0],
  'empresa.criar':          [0, 0, 1, 1, 1, 0],
  'empresa.excluir':        [0, 1, 1, 1, 1, 0],
  'api.gerir':              [0, 0, 1, 0, 1, 0],
  'usuarios.gerir':         [0, 0, 1, 0, 1, 0],
  'empresas.todas':         [0, 0, 1, 0, 1, 0],
  'configuracao.sem-senha': [0, 0, 1, 0, 1, 0],
};

test('permissões: matriz de camadas por ação', () => {
  assert.deepStrictEqual(Object.keys(PERMISSOES).sort(), Object.keys(MATRIZ).sort());
  for (const [acao, colunas] of Object.entries(MATRIZ)) {
    PAPEIS.forEach((papel, i) => assert.strictEqual(podeFazer(papel, acao), Boolean(colunas[i]), `${acao} para ${papel}`));
  }
});

test('permissões: ação desconhecida falha alto e papel desconhecido nunca pode', () => {
  assert.throws(() => podeFazer('admin', 'nao.existe'), /desconhecida/);
  assert.strictEqual(podeFazer('qualquer', 'painel.usar'), false);
});

test('permissões: a tabela é congelada', () => {
  assert.throws(() => { 'use strict'; PERMISSOES['api.gerir'] = ['equipe']; }, TypeError);
});
