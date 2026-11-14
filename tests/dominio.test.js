'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { criarStore, addLoja } = require('../src/store');
const { lerConfig, atualizar } = require('../src/agentes');
const { reservar } = require('../src/reservas');
const { mapa } = require('../src/mapa');

function setup() {
  const s = criarStore();
  const amb = () => [
    { nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] },
    { nome: 'externa', mesas: [{ id: 'E1', capacidade: 4, reservavel: true }] },
  ];
  addLoja(s, {
    id: 'L1', nome: 'Loja 1', ambientes: amb(),
    agente: { descricao: 'd1', habilidades: ['h'], produtos: ['p'], restricoes: ['r'], editavelPor: { descricao: ['cliente', 'integracao'] } },
  });
  addLoja(s, { id: 'L2', nome: 'Loja 2', ambientes: amb(), agente: { descricao: 'd2', habilidades: [], produtos: [], restricoes: [] } });
  return s;
}

const base = { lojaId: 'L1', data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao' };

test('config é isolada por loja e completa', () => {
  const s = setup();
  assert.strictEqual(lerConfig(s, 'L1').descricao, 'd1');
  assert.strictEqual(lerConfig(s, 'L2').descricao, 'd2');
  assert.deepStrictEqual(Object.keys(lerConfig(s, 'L1')), ['descricao', 'habilidades', 'produtos', 'restricoes']);
  assert.throws(() => lerConfig(s, 'X'), { codigo: 404 });
});

test('permissões de edição por campo', () => {
  const s = setup();
  atualizar(s, 'L1', 'descricao', 'novo', 'cliente');
  assert.strictEqual(lerConfig(s, 'L1').descricao, 'novo');
  assert.throws(() => atualizar(s, 'L1', 'produtos', [], 'cliente'), { codigo: 403 });
  atualizar(s, 'L1', 'produtos', ['x'], 'integracao');
  assert.deepStrictEqual(lerConfig(s, 'L1').produtos, ['x']);
});

test('reserva confirma e é idempotente', () => {
  const s = setup();
  const a = reservar(s, { ...base, chave: 'k1' });
  const b = reservar(s, { ...base, chave: 'k1' });
  assert.strictEqual(a.status, 'confirmada');
  assert.deepStrictEqual(a, b);
  assert.strictEqual(s.reservas.length, 1);
});

test('indisponível oferece outro ambiente; lojas isoladas', () => {
  const s = setup();
  reservar(s, { ...base, chave: 'a' });
  const x = reservar(s, { ...base, chave: 'b' });
  assert.strictEqual(x.status, 'indisponivel');
  assert.deepStrictEqual(x.alternativas, [{ tipo: 'outro-ambiente', ambiente: 'externa' }]);
  assert.strictEqual(reservar(s, { ...base, lojaId: 'L2', chave: 'c' }).status, 'confirmada');
});

test('mapa mostra reserva no horário', () => {
  const s = setup();
  reservar(s, { ...base, chave: 'a' });
  assert.strictEqual(mapa(s, 'L1', '2026-11-20', '20:30')[0].mesas[0].situacao, 'reservada');
  assert.strictEqual(mapa(s, 'L1', '2026-11-20', '23:00')[0].mesas[0].situacao, 'livre');
});
