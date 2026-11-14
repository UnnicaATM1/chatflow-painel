'use strict';

// Uso: KENDJI_TOKEN_CHAT=... KENDJI_TOKEN_CLIENTE=... KENDJI_TOKEN_INTEGRACAO=... node src/server.js
// Dados de demonstração em memória (as 3 empresas); persistência real fica para a próxima feature.
const { criarStore, addEmpresa } = require('./store');
const { criarServidor } = require('./api');

const store = criarStore();
for (const n of [1, 2, 3]) {
  addEmpresa(store, {
    id: `empresa_${n}`,
    nome: `Empresa ${n}`,
    ambientes: [
      { nome: 'salao', mesas: [{ id: `S1`, capacidade: 4, reservavel: true }, { id: `S2`, capacidade: 6, reservavel: true }] },
      { nome: 'externa', mesas: [{ id: `E1`, capacidade: 4, reservavel: true }] },
    ],
    agente: {
      nome: `Agente da Empresa ${n}`, descricao: '', personalidade: '', habilidades: '', produtos: '', restricoes: '',
      editavelPor: Object.fromEntries(['nome', 'descricao', 'personalidade', 'habilidades', 'produtos', 'restricoes'].map((c) => [c, ['cliente', 'integracao']])),
    },
  });
}

// KENDJI_TOKEN_CHAT é opcional e legado: uma chave global do chat vê TODAS as empresas. Prefira a chave de API de cada empresa.
const tokens = {
  chat: process.env.KENDJI_TOKEN_CHAT,
  cliente: process.env.KENDJI_TOKEN_CLIENTE,
  integracao: process.env.KENDJI_TOKEN_INTEGRACAO,
};
const porta = Number(process.env.PORT) || 3000;
// KENDJI_ADMIN_SENHA: senha do administrador para excluir empresa. Defina só no ambiente do servidor, nunca no código.
criarServidor(store, tokens, { adminSenha: process.env.KENDJI_ADMIN_SENHA }).listen(porta, () => console.log(`Kendji ONE API na porta ${porta}`));
