'use strict';

// Contexto completo do agente de uma empresa, pronto para o sistema de conversa:
// o bloco do agente, os recursos ligados, a base de conhecimento e um prompt montado.
// Sem travessões nos textos (regra do design system para textos de agente).
const { lerConfig } = require('./agentes');
const conhecimento = require('./conhecimento');

// Recursos que a empresa usa e os endereços que o sistema de conversa pode chamar.
function recursosDe(e) {
  const base = `/empresas/${e.id}`;
  const endpoints = [
    { metodo: 'GET', caminho: `${base}/contexto`, descricao: 'contexto completo do agente em uma chamada' },
    { metodo: 'GET', caminho: `${base}/agente`, descricao: 'configuração do agente' },
  ];
  if (e.modulos.reservas) {
    endpoints.push({ metodo: 'GET', caminho: `${base}/disponibilidade?data=AAAA-MM-DD&horario=HH:MM&pessoas=N`, descricao: 'mesas livres por ambiente' });
    endpoints.push({ metodo: 'POST', caminho: `${base}/reservas`, descricao: 'registrar reserva (cabeçalho Idempotency-Key)' });
  }
  if (e.modulos.conhecimento) {
    endpoints.push({ metodo: 'GET', caminho: `${base}/conhecimento`, descricao: 'todos os itens de conhecimento (textos, tabelas, documentos)' });
    endpoints.push({ metodo: 'GET', caminho: `${base}/conhecimento/:itemId`, descricao: 'um item' });
  }
  return { empresa: e.nome, reservas: e.modulos.reservas, conhecimento: e.modulos.conhecimento, endpoints };
}

const celula = (c) => String(c).replace(/\|/g, '/').replace(/\n/g, ' ');

function tabelaMarkdown(t) {
  const linhas = [`| ${t.colunas.map(celula).join(' | ')} |`, `| ${t.colunas.map(() => '---').join(' | ')} |`];
  for (const l of t.linhas) linhas.push(`| ${l.map(celula).join(' | ')} |`);
  return linhas.join('\n');
}

function secao(titulo, texto) {
  return texto && texto.trim() ? `\n## ${titulo}\n${texto.trim()}\n` : '';
}

function montarPrompt(e, agente, itens) {
  let p = `Você é ${agente.nome.trim() || 'o assistente'}, atendente virtual da empresa ${e.nome}.\n`;
  if (agente.descricao.trim()) p += `\n${agente.descricao.trim()}\n`;
  p += secao('Personalidade e objetivo', agente.personalidade);
  p += secao('Habilidades', agente.habilidades);
  p += secao('Produtos e serviços', agente.produtos);
  p += secao('Restrições', agente.restricoes);

  if (itens.length) {
    p += '\n## Base de conhecimento\nUse estas informações para responder. Se algo não estiver aqui, diga que vai confirmar com a equipe e não invente.\n';
    for (const it of itens) {
      if (it.tipo === 'tabela') p += `\n### ${it.titulo}\n${tabelaMarkdown(it.tabela)}\n`;
      else if (it.tipo === 'texto') p += `\n### ${it.titulo}\n${it.texto}\n`;
      else {
        p += `\n### ${it.titulo} (documento ${it.arquivo.nome})\n`;
        p += it.texto !== undefined ? `${it.texto}\n` : `Arquivo disponível para consulta em ${it.arquivo.url}\n`;
      }
    }
  }

  if (e.modulos.reservas) {
    p += `\n## Reservas de mesa
Para reservar: 1) pergunte data, horário, número de pessoas e o ambiente preferido; 2) consulte a disponibilidade antes de oferecer qualquer horário; 3) ofereça ao cliente apenas as mesas livres devolvidas; 4) quando o cliente escolher, registre a reserva; 5) só confirme ao cliente depois que o sistema responder "confirmada". Se a resposta for "indisponivel", ofereça as alternativas devolvidas e não prometa mesa.
`;
  }
  return p.trim() + '\n';
}

function contexto(store, empresaId) {
  const e = require('./agentes').empresa(store, empresaId);
  const agente = lerConfig(store, empresaId);
  const itens = e.modulos.conhecimento ? conhecimento.listarPublico(store, empresaId) : [];
  const r = recursosDe(e);
  return {
    empresa: { id: e.id, nome: e.nome },
    agente,
    recursos: { reservas: r.reservas, conhecimento: r.conhecimento },
    conhecimento: itens,
    prompt: montarPrompt(e, agente, itens),
  };
}

module.exports = { contexto, recursosDe, montarPrompt };
