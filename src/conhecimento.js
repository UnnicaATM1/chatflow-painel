'use strict';

// Base de conhecimento de uma empresa: itens de texto, tabela (ex.: tabela de preços) e documento.
// O sistema de conversa lê tudo por GET; a equipe edita pelo painel.
import { empresa } from './agentes.js';

const LIM = {
  titulo: 120,
  texto: 50000,
  textoDoc: 200000, // texto extraído de .txt/.md/.csv
  colunas: 20,
  nomeColuna: 60,
  linhas: 1000,
  celula: 500,
  itens: 200,
  arquivoBytes: 4 * 1024 * 1024,
  nomeArquivo: 120,
};
const TIPOS = ['texto', 'tabela', 'documento'];

// Só tipos conhecidos; nunca HTML/SVG/JS (o arquivo é servido do mesmo endereço do painel).
const EXT = {
  txt: { mime: 'text/plain; charset=utf-8', texto: true },
  md: { mime: 'text/plain; charset=utf-8', texto: true },
  csv: { mime: 'text/plain; charset=utf-8', texto: true },
  pdf: { mime: 'application/pdf', magic: (b) => b.length > 4 && b.subarray(0, 4).toString('latin1') === '%PDF' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b },
};

function erro(msg, codigo) {
  return Object.assign(new Error(msg), { codigo });
}

const tam = (s) => [...s].length;

function texto(v, campo, max, obrigatorio) {
  if (typeof v !== 'string') throw erro(`${campo} deve ser texto`, 400);
  if (obrigatorio && !v.trim()) throw erro(`${campo} é obrigatório`, 400);
  if (tam(v) > max) throw erro(`${campo} passa do limite de ${max} caracteres`, 400);
  return v;
}

function validarTabela(t) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.colunas) || !Array.isArray(t.linhas)) throw erro('tabela deve ter colunas e linhas', 400);
  if (t.colunas.length < 1 || t.colunas.length > LIM.colunas) throw erro(`a tabela deve ter de 1 a ${LIM.colunas} colunas`, 400);
  if (t.linhas.length > LIM.linhas) throw erro(`a tabela passa do limite de ${LIM.linhas} linhas`, 400);
  const colunas = t.colunas.map((c) => {
    const s = texto(typeof c === 'number' ? String(c) : c, 'nome de coluna', LIM.nomeColuna, true).trim();
    return s;
  });
  const linhas = t.linhas.map((l, i) => {
    if (!Array.isArray(l) || l.length !== colunas.length) throw erro(`a linha ${i + 1} deve ter ${colunas.length} células`, 400);
    return l.map((c) => texto(typeof c === 'number' ? String(c) : c, 'célula', LIM.celula, false));
  });
  return { colunas, linhas };
}

function lerArquivo(a) {
  if (!a || typeof a !== 'object' || typeof a.nome !== 'string' || typeof a.base64 !== 'string') throw erro('arquivo deve ter nome e base64', 400);
  const nome = a.nome.split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
  if (!nome || tam(nome) > LIM.nomeArquivo) throw erro(`nome do arquivo deve ter de 1 a ${LIM.nomeArquivo} caracteres`, 400);
  const ext = (nome.includes('.') ? nome.split('.').pop() : '').toLowerCase();
  const regra = EXT[ext];
  if (!regra) throw erro(`tipo de arquivo não permitido; use ${Object.keys(EXT).join(', ')}`, 400);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a.base64)) throw erro('base64 inválido', 400);
  const estimado = Math.floor((a.base64.length * 3) / 4);
  if (estimado > LIM.arquivoBytes + 2) throw erro(`arquivo passa do limite de ${LIM.arquivoBytes / 1024 / 1024} MB`, 400);
  const buffer = Buffer.from(a.base64, 'base64');
  if (buffer.length === 0) throw erro('arquivo vazio', 400);
  if (buffer.length > LIM.arquivoBytes) throw erro(`arquivo passa do limite de ${LIM.arquivoBytes / 1024 / 1024} MB`, 400);
  if (regra.magic && !regra.magic(buffer)) throw erro(`o conteúdo não corresponde a um arquivo .${ext}`, 400);
  let extraido;
  if (regra.texto) {
    extraido = buffer.toString('utf8');
    if (extraido.includes('\u0000')) throw erro('o arquivo não parece ser texto', 400);
    if (tam(extraido) > LIM.textoDoc) throw erro(`o texto do arquivo passa do limite de ${LIM.textoDoc} caracteres`, 400);
  }
  return { arquivo: { nome, mime: regra.mime, tamanho: buffer.length, base64: a.base64 }, texto: extraido };
}

function achar(store, empresaId, id) {
  const e = empresa(store, empresaId);
  const item = e.conhecimento.find((x) => x.id === id);
  if (!item) throw erro('item de conhecimento inexistente', 404);
  return { e, item };
}

// O que o sistema de conversa e a tela recebem (sem os bytes do arquivo).
function publica(empresaId, item) {
  const out = { id: item.id, titulo: item.titulo, tipo: item.tipo, atualizadoEm: item.atualizadoEm };
  if (item.texto !== undefined) out.texto = item.texto;
  if (item.tabela) out.tabela = item.tabela;
  if (item.arquivo) {
    out.arquivo = { nome: item.arquivo.nome, mime: item.arquivo.mime, tamanho: item.arquivo.tamanho, url: `/empresas/${empresaId}/conhecimento/${item.id}/arquivo` };
  }
  return out;
}

// Versão para o histórico: conteúdo sem bytes de arquivo e sem campos que mudam sozinhos.
function resumo(item) {
  const out = { titulo: item.titulo, tipo: item.tipo };
  if (item.texto !== undefined) out.texto = item.texto;
  if (item.tabela) out.tabela = item.tabela;
  if (item.arquivo) out.arquivo = { nome: item.arquivo.nome, mime: item.arquivo.mime, tamanho: item.arquivo.tamanho };
  return out;
}

function listarPublico(store, empresaId) {
  const e = empresa(store, empresaId);
  return e.conhecimento.map((i) => publica(empresaId, i));
}

function obter(store, empresaId, id) {
  const { item } = achar(store, empresaId, id);
  return publica(empresaId, item);
}

function criar(store, empresaId, dados) {
  const e = empresa(store, empresaId);
  if (!dados || typeof dados !== 'object') throw erro('corpo inválido', 400);
  if (e.conhecimento.length >= LIM.itens) throw erro(`limite de ${LIM.itens} itens de conhecimento por empresa`, 400);
  if (!TIPOS.includes(dados.tipo)) throw erro(`tipo deve ser um de: ${TIPOS.join(', ')}`, 400);
  const agora = new Date().toISOString();
  const item = { id: e.proxConhecimento, titulo: texto(dados.titulo, 'título', LIM.titulo, true).trim(), tipo: dados.tipo, criadoEm: agora, atualizadoEm: agora };
  if (dados.tipo === 'texto') item.texto = texto(dados.texto, 'texto', LIM.texto, true);
  if (dados.tipo === 'tabela') item.tabela = validarTabela(dados.tabela);
  if (dados.tipo === 'documento') {
    const l = lerArquivo(dados.arquivo);
    item.arquivo = l.arquivo;
    if (l.texto !== undefined) item.texto = l.texto;
  }
  e.proxConhecimento += 1;
  e.conhecimento.push(item);
  return item;
}

function editar(store, empresaId, id, dados) {
  const { item } = achar(store, empresaId, id);
  if (!dados || typeof dados !== 'object') throw erro('corpo inválido', 400);
  if (dados.tipo !== undefined && dados.tipo !== item.tipo) throw erro('o tipo do item não pode ser alterado', 400);
  const novo = {};
  if (dados.titulo !== undefined) novo.titulo = texto(dados.titulo, 'título', LIM.titulo, true).trim();
  if (item.tipo === 'texto' && dados.texto !== undefined) novo.texto = texto(dados.texto, 'texto', LIM.texto, true);
  if (item.tipo === 'tabela' && dados.tabela !== undefined) novo.tabela = validarTabela(dados.tabela);
  if (item.tipo === 'documento' && dados.arquivo !== undefined) {
    const l = lerArquivo(dados.arquivo);
    novo.arquivo = l.arquivo;
    novo.texto = l.texto; // pode ser undefined (pdf/docx/xlsx): limpa o texto do arquivo anterior
  }
  if (Object.keys(novo).length === 0) throw erro('nenhuma alteração informada', 400);
  Object.assign(item, novo, { atualizadoEm: new Date().toISOString() });
  if (item.tipo === 'documento' && item.texto === undefined) delete item.texto;
  return item;
}

function excluir(store, empresaId, id) {
  const { e, item } = achar(store, empresaId, id);
  e.conhecimento = e.conhecimento.filter((x) => x.id !== id);
  return item;
}

function arquivoDe(store, empresaId, id) {
  const { item } = achar(store, empresaId, id);
  if (!item.arquivo) throw erro('este item não tem arquivo', 404);
  return { nome: item.arquivo.nome, mime: item.arquivo.mime, buffer: Buffer.from(item.arquivo.base64, 'base64') };
}


// ---- Busca: o chat pergunta por um assunto e recebe só o que interessa (linhas de tabela, parágrafos) ----
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'o', 'a', 'os', 'as', 'e', 'em', 'para', 'por', 'com', 'que', 'qual', 'quais', 'quanto', 'quanta', 'custa', 'voces', 'tem', 'me', 'se', 'ao', 'aos']);

function termos(q) {
  return norm(q).split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !PALAVRAS_VAZIAS.has(t)).map((t) => (t.length > 3 ? t.replace(/s$/, '') : t));
}
const acertos = (texto, ts) => { const n = norm(texto); return ts.filter((t) => n.includes(t)).length; };

function buscar(store, empresaId, consulta, limite = 5) {
  const e = empresa(store, empresaId);
  const q = typeof consulta === 'string' ? consulta.trim() : '';
  if (!q) throw erro('informe o assunto da busca em q', 400);
  if ([...q].length > 200) throw erro('a busca passa do limite de 200 caracteres', 400);
  const ts = termos(q);
  // pergunta genérica demais: devolve o catálogo para a IA escolher
  if (ts.length === 0) {
    return { consulta: q, catalogo: true, total: e.conhecimento.length, resultados: e.conhecimento.map((i) => ({ id: i.id, titulo: i.titulo, tipo: i.tipo })) };
  }
  const out = [];
  for (const it of e.conhecimento) {
    const noTitulo = acertos(it.titulo + ' ' + (it.arquivo ? it.arquivo.nome : ''), ts);
    if (it.tipo === 'tabela') {
      const linhas = it.tabela.linhas.map((l) => ({ l, s: acertos(l.join(' '), ts) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      if (linhas.length) out.push({ pontos: linhas[0].s * 2 + noTitulo, r: { id: it.id, titulo: it.titulo, tipo: 'tabela', colunas: it.tabela.colunas, linhas: linhas.slice(0, 20).map((x) => x.l), parcial: linhas.length < it.tabela.linhas.length } });
      else if (noTitulo) out.push({ pontos: noTitulo, r: { id: it.id, titulo: it.titulo, tipo: 'tabela', colunas: it.tabela.colunas, linhas: it.tabela.linhas.slice(0, 50), parcial: it.tabela.linhas.length > 50 } });
    } else if (it.texto !== undefined) {
      const paragrafos = it.texto.split(/\n+/).map((p) => ({ p: p.trim(), s: 0 })).filter((x) => x.p);
      paragrafos.forEach((x) => { x.s = acertos(x.p, ts); });
      const bons = paragrafos.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5);
      const base = { id: it.id, titulo: it.titulo, tipo: it.tipo };
      if (it.arquivo) base.arquivo = { nome: it.arquivo.nome, url: `/empresas/${empresaId}/conhecimento/${it.id}/arquivo` };
      if (bons.length) out.push({ pontos: bons[0].s * 2 + noTitulo, r: { ...base, trechos: bons.map((x) => x.p) } });
      else if (noTitulo) out.push({ pontos: noTitulo, r: { ...base, trechos: [it.texto.slice(0, 600)] } });
    } else if (it.arquivo && noTitulo) {
      out.push({ pontos: noTitulo, r: { id: it.id, titulo: it.titulo, tipo: 'documento', arquivo: { nome: it.arquivo.nome, url: `/empresas/${empresaId}/conhecimento/${it.id}/arquivo` } } });
    }
  }
  out.sort((a, b) => b.pontos - a.pontos);
  const resultados = out.slice(0, Math.min(Math.max(Number(limite) || 5, 1), 10)).map((x) => x.r);
  return { consulta: q, total: out.length, resultados };
}

export { buscar, LIM, TIPOS, criar, editar, excluir, obter, listarPublico, arquivoDe, publica, resumo, achar };
