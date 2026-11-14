'use strict';

// Uso: KENDJI_TOKEN_CHAT=... KENDJI_TOKEN_CLIENTE=... KENDJI_TOKEN_INTEGRACAO=... node src/server.js
// Dados de demonstração em memória (as 3 lojas); persistência real fica para a próxima feature.
const { criarStore, addLoja } = require('./store');
const { criarServidor } = require('./api');

const store = criarStore();
for (const n of [1, 2, 3]) {
  addLoja(store, {
    id: `L${n}`,
    nome: `Loja ${n}`,
    ambientes: [
      { nome: 'salao', mesas: [{ id: `L${n}-S1`, capacidade: 4, reservavel: true }, { id: `L${n}-S2`, capacidade: 6, reservavel: true }] },
      { nome: 'externa', mesas: [{ id: `L${n}-E1`, capacidade: 4, reservavel: true }] },
    ],
    agente: {
      descricao: `Agente da Loja ${n}`, habilidades: [], produtos: [], restricoes: [],
      editavelPor: { descricao: ['cliente', 'integracao'], habilidades: ['cliente', 'integracao'], produtos: ['cliente', 'integracao'] },
    },
  });
}

const tokens = {
  chat: process.env.KENDJI_TOKEN_CHAT,
  cliente: process.env.KENDJI_TOKEN_CLIENTE,
  integracao: process.env.KENDJI_TOKEN_INTEGRACAO,
};
const porta = Number(process.env.PORT) || 3000;
criarServidor(store, tokens).listen(porta, () => console.log(`Kendji ONE API na porta ${porta}`));
