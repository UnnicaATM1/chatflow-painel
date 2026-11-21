'use strict';

// Uso: CHATFLOW_DEMO=1 CHATFLOW_TOKEN_CHAT=... CHATFLOW_TOKEN_CLIENTE=... CHATFLOW_TOKEN_INTEGRACAO=... node src/server.js
// Dados de demonstração em memória (as 3 empresas); persistência real fica para a próxima feature.
import { criarStore, addEmpresa } from '../store.js';
import { criarServidor } from './servidor.js';
import fs from 'node:fs';
import { plataformaNode } from './plataforma.js';

// CHATFLOW_HISTORICO_ARQUIVO: grava cada evento de histórico (JSON por linha) neste arquivo, além da memória.
const arquivoHistorico = process.env.CHATFLOW_HISTORICO_ARQUIVO || null;
const sink = arquivoHistorico ? (e) => {
  try { fs.appendFileSync(arquivoHistorico, JSON.stringify(e) + '\n', 'utf8'); }
  catch (err) { console.error('falha ao gravar histórico em arquivo:', err.message); }
} : null;
// CHATFLOW_IDEMPOTENCIA_HORAS (padrão 24) e CHATFLOW_IDEMPOTENCIA_MAX (padrão 10000 por empresa): validade e teto das
// respostas de idempotência guardadas em memória.
const store = criarStore({
  plat: plataformaNode(),
  sink,
  idempotenciaTtlMs: Number(process.env.CHATFLOW_IDEMPOTENCIA_HORAS) * 3600 * 1000 || undefined,
  idempotenciaMax: Number(process.env.CHATFLOW_IDEMPOTENCIA_MAX) || undefined,
});
// As 3 empresas de demonstração só existem com CHATFLOW_DEMO=1. Em produção o servidor começa vazio.
const demo = process.env.CHATFLOW_DEMO === '1';
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

// CHATFLOW_SEMENTE_ARQUIVO (só para testes de contrato): JSON com a lista de empresas iniciais (mesmos campos de addEmpresa).
if (process.env.CHATFLOW_SEMENTE_ARQUIVO) {
  for (const e of JSON.parse(fs.readFileSync(process.env.CHATFLOW_SEMENTE_ARQUIVO, 'utf8'))) await addEmpresa(store, e);
}

// CHATFLOW_TOKEN_CHAT é opcional e legado: uma chave global do chat vê TODAS as empresas. Prefira a chave de API de cada empresa.
const tokens = {
  chat: process.env.CHATFLOW_TOKEN_CHAT,
  cliente: process.env.CHATFLOW_TOKEN_CLIENTE,
  integracao: process.env.CHATFLOW_TOKEN_INTEGRACAO,
};
const porta = Number(process.env.PORT) || 3000;
// CHATFLOW_ADMIN_SENHA: senha do administrador para excluir empresa. Defina só no ambiente do servidor, nunca no código.
criarServidor(store, tokens, {
  adminSenha: process.env.CHATFLOW_ADMIN_SENHA,
  // CHATFLOW_CORS_ORIGENS: origens do painel separadas por vírgula (lista exata). CHATFLOW_CONFIAR_PROXY=1: usar X-Forwarded-For.
  corsOrigens: (process.env.CHATFLOW_CORS_ORIGENS || '').split(','),
  confiarProxy: process.env.CHATFLOW_CONFIAR_PROXY === '1',
  // CHATFLOW_LIMITE_CHAVE / CHATFLOW_LIMITE_INVALIDAS: requisições por minuto por chave válida (padrão 300) e por IP com chave inválida (padrão 20).
  limitePorChavePorMinuto: Number(process.env.CHATFLOW_LIMITE_CHAVE) || undefined,
  limiteInvalidasPorMinuto: Number(process.env.CHATFLOW_LIMITE_INVALIDAS) || undefined,
  fuso: process.env.CHATFLOW_FUSO, // fuso de negócio (padrão America/Sao_Paulo); hoje só carregado, nenhuma regra usa "agora"
}).listen(porta, () => console.log(`ChatFlow Painel API na porta ${porta}`));
