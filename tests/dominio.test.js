'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { criarStore, addEmpresa } = require('../src/store');
const { lerConfig, atualizar } = require('../src/agentes');
const { reservar } = require('../src/reservas');
const { mapa } = require('../src/mapa');

async function setup() {
  const s = criarStore();
  const amb = () => [
    { nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] },
    { nome: 'externa', mesas: [{ id: 'E1', capacidade: 4, reservavel: true }] },
  ];
  await addEmpresa(s, {
    id: 'empresa_1', nome: 'Empresa 1', ambientes: amb(),
    agente: { descricao: 'd1', personalidade: 'pe', habilidades: 'h', produtos: 'p', restricoes: 'r', editavelPor: { descricao: ['cliente', 'integracao'] } },
  });
  await addEmpresa(s, { id: 'empresa_2', nome: 'Empresa 2', ambientes: amb(), agente: { descricao: 'd2', habilidades: '', produtos: '', restricoes: '' } });
  return s;
}

const base = { empresaId: 'empresa_1', data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao' };

test('config é isolada por empresa e completa', async () => {
  const s = await setup();
  assert.strictEqual((await lerConfig(s, 'empresa_1')).descricao, 'd1');
  assert.strictEqual((await lerConfig(s, 'empresa_2')).descricao, 'd2');
  assert.deepStrictEqual(Object.keys(await lerConfig(s, 'empresa_1')), ['nome', 'descricao', 'personalidade', 'habilidades', 'produtos', 'restricoes']);
  await assert.rejects(() => lerConfig(s, 'X'), { codigo: 404 });
});

test('permissões de edição por campo', async () => {
  const s = await setup();
  await atualizar(s, 'empresa_1', 'descricao', 'novo', 'cliente');
  assert.strictEqual((await lerConfig(s, 'empresa_1')).descricao, 'novo');
  await assert.rejects(() => atualizar(s, 'empresa_1', 'produtos', 'x', 'cliente'), { codigo: 403 });
  await atualizar(s, 'empresa_1', 'produtos', 'x', 'integracao');
  assert.strictEqual((await lerConfig(s, 'empresa_1')).produtos, 'x');
});

test('reserva confirma e é idempotente', async () => {
  const s = await setup();
  const a = await reservar(s, { ...base, chave: 'k1' });
  const b = await reservar(s, { ...base, chave: 'k1' });
  assert.strictEqual(a.status, 'confirmada');
  assert.deepStrictEqual(a, b);
  assert.strictEqual((await s.reservaListar('empresa_1')).length, 1);
});

test('indisponível oferece outro ambiente; empresas isoladas', async () => {
  const s = await setup();
  await reservar(s, { ...base, chave: 'a' });
  const x = await reservar(s, { ...base, chave: 'b' });
  assert.strictEqual(x.status, 'indisponivel');
  assert.deepStrictEqual(x.alternativas, [{ tipo: 'outro-ambiente', ambiente: 'externa' }]);
  assert.strictEqual((await reservar(s, { ...base, empresaId: 'empresa_2', chave: 'c' })).status, 'confirmada');
});

test('mapa mostra reserva no horário', async () => {
  const s = await setup();
  await reservar(s, { ...base, chave: 'a' });
  assert.strictEqual((await mapa(s, 'empresa_1', '2026-11-20', '20:30'))[0].mesas[0].situacao, 'reservada');
  assert.strictEqual((await mapa(s, 'empresa_1', '2026-11-20', '23:00'))[0].mesas[0].situacao, 'livre');
});

// ---- datas sem fuso: fronteira da meia-noite e sobreposição exata de 90 minutos ----
const { minutosAbsolutos } = require('../src/tempo');

test('minutos absolutos: virada de dia, mês e ano, e datas impossíveis', () => {
  assert.strictEqual(minutosAbsolutos('2026-11-21', '00:30') - minutosAbsolutos('2026-11-20', '23:30'), 60);
  assert.strictEqual(minutosAbsolutos('2027-01-01', '00:00') - minutosAbsolutos('2026-12-31', '23:59'), 1);
  assert.strictEqual(minutosAbsolutos('2028-03-01', '00:00') - minutosAbsolutos('2028-02-29', '00:00'), 1440);
  for (const [d, h] of [['2026-02-30', '10:00'], ['2026-13-01', '10:00'], ['2026-11-20', '24:00'], ['2026-11-20', '10:60'], ['x', '10:00']]) {
    assert.throws(() => minutosAbsolutos(d, h), (e) => e.codigo === 400, `${d} ${h}`);
  }
});

test('reserva às 23:30 cruza a meia-noite e bloqueia a mesa até 01:00 do dia seguinte', async () => {
  const s = await setup();
  const a = await reservar(s, { ...base, data: '2026-11-20', horario: '23:30', chave: 'm1' });
  assert.strictEqual(a.status, 'confirmada');
  assert.strictEqual((await reservar(s, { ...base, data: '2026-11-21', horario: '00:30', chave: 'm2' })).status, 'indisponivel');
  assert.strictEqual((await reservar(s, { ...base, data: '2026-11-21', horario: '00:59', chave: 'm3' })).status, 'indisponivel');
  assert.strictEqual((await reservar(s, { ...base, data: '2026-11-21', horario: '01:00', chave: 'm4' })).status, 'confirmada');
  assert.strictEqual((await mapa(s, 'empresa_1', '2026-11-21', '00:15'))[0].mesas[0].situacao, 'reservada');
});

test('sobreposição de exatamente 90 minutos: 21:30 livre, 21:29 ocupa', async () => {
  const s = await setup();
  assert.strictEqual((await reservar(s, { ...base, chave: 'a1' })).status, 'confirmada'); // 20:00 a 21:30
  assert.strictEqual((await reservar(s, { ...base, horario: '21:29', chave: 'a2' })).status, 'indisponivel');
  assert.strictEqual((await reservar(s, { ...base, horario: '21:30', chave: 'a3' })).status, 'confirmada');
  assert.strictEqual((await reservar(s, { ...base, horario: '18:31', chave: 'a4' })).status, 'indisponivel'); // termina 20:01
  assert.strictEqual((await reservar(s, { ...base, horario: '18:30', chave: 'a5' })).status, 'confirmada'); // termina 20:00
});
