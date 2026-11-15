'use strict';

// Uso: KENDJI_DEMO=1 KENDJI_TOKEN_CHAT=... KENDJI_TOKEN_CLIENTE=... KENDJI_TOKEN_INTEGRACAO=... node src/server.js
// Dados de demonstração em memória (as 3 empresas); persistência real fica para a próxima feature.
import { criarStore, addEmpresa } from './store.js';
import { criarServidor } from './api.js';
import fs from 'node:fs';
import { plataformaNode } from './node/plataforma.js';

// KENDJI_HISTORICO_ARQUIVO: grava cada evento de histórico (JSON por linha) neste arquivo, além da memória.
const arquivoHistorico = process.env.KENDJI_HISTORICO_ARQUIVO || null;
const sink = arquivoHistorico ? (e) => {
  try { fs.appendFileSync(arquivoHistorico, JSON.stringify(e) + '\n', 'utf8'); }
  catch (err) { console.error('falha ao gravar histórico em arquivo:', err.message); }
} : null;
const store = criarStore({ plat: plataformaNode(), sink });
// As 3 empresas de demonstração só existem com KENDJI_DEMO=1. Em produção o servidor começa vazio.
const demo = process.env.KENDJI_DEMO === '1';
for (const n of demo ? [1, 2, 3] : []) {
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
criarServidor(store, tokens, {
  adminSenha: process.env.KENDJI_ADMIN_SENHA,
  // KENDJI_CORS_ORIGENS: origens do painel separadas por vírgula (lista exata). KENDJI_CONFIAR_PROXY=1: usar X-Forwarded-For.
  corsOrigens: (process.env.KENDJI_CORS_ORIGENS || '').split(','),
  confiarProxy: process.env.KENDJI_CONFIAR_PROXY === '1',
}).listen(porta, () => console.log(`Kendji ONE API na porta ${porta}`));
