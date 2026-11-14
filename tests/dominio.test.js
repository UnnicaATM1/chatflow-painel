'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { criarStore, addEmpresa } = require('../src/store');
const { lerConfig, atualizar } = require('../src/agentes');
const { reservar } = require('../src/reservas');
const { mapa } = require('../src/mapa');

function setup() {
  const s = criarStore();
  const amb = () => [
    { nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] },
    { nome: 'externa', mesas: [{ id: 'E1', capacidade: 4, reservavel: true }] },
  ];
  addEmpresa(s, {
    id: 'empresa_1', nome: 'Empresa 1', ambientes: amb(),
    agente: { descricao: 'd1', personalidade: 'pe', habilidades: 'h', produtos: 'p', restricoes: 'r', editavelPor: { descricao: ['cliente', 'integracao'] } },
  });
  addEmpresa(s, { id: 'empresa_2', nome: 'Empresa 2', ambientes: amb(), agente: { descricao: 'd2', habilidades: '', produtos: '', restricoes: '' } });
  return s;
}

const base = { empresaId: 'empresa_1', data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao' };

test('config é isolada por empresa e completa', () => {
  const s = setup();
  assert.strictEqual(lerConfig(s, 'empresa_1').descricao, 'd1');
  assert.strictEqual(lerConfig(s, 'empresa_2').descricao, 'd2');
  assert.deepStrictEqual(Object.keys(lerConfig(s, 'empresa_1')), ['nome', 'descricao', 'personalidade', 'habilidades', 'produtos', 'restricoes']);
  assert.throws(() => lerConfig(s, 'X'), { codigo: 404 });
});

test('permissões de edição por campo', () => {
  const s = setup();
  atualizar(s, 'empresa_1', 'descricao', 'novo', 'cliente');
  assert.strictEqual(lerConfig(s, 'empresa_1').descricao, 'novo');
  assert.throws(() => atualizar(s, 'empresa_1', 'produtos', 'x', 'cliente'), { codigo: 403 });
  atualizar(s, 'empresa_1', 'produtos', 'x', 'integracao');
  assert.strictEqual(lerConfig(s, 'empresa_1').produtos, 'x');
});

test('reserva confirma e é idempotente', () => {
  const s = setup();
  const a = reservar(s, { ...base, chave: 'k1' });
  const b = reservar(s, { ...base, chave: 'k1' });
  assert.strictEqual(a.status, 'confirmada');
  assert.deepStrictEqual(a, b);
  assert.strictEqual(s.reservas.length, 1);
});

test('indisponível oferece outro ambiente; empresas isoladas', () => {
  const s = setup();
  reservar(s, { ...base, chave: 'a' });
  const x = reservar(s, { ...base, chave: 'b' });
  assert.strictEqual(x.status, 'indisponivel');
  assert.deepStrictEqual(x.alternativas, [{ tipo: 'outro-ambiente', ambiente: 'externa' }]);
  assert.strictEqual(reservar(s, { ...base, empresaId: 'empresa_2', chave: 'c' }).status, 'confirmada');
});

test('mapa mostra reserva no horário', () => {
  const s = setup();
  reservar(s, { ...base, chave: 'a' });
  assert.strictEqual(mapa(s, 'empresa_1', '2026-11-20', '20:30')[0].mesas[0].situacao, 'reservada');
  assert.strictEqual(mapa(s, 'empresa_1', '2026-11-20', '23:00')[0].mesas[0].situacao, 'livre');
});
