'use strict';

// Contexto completo do agente de uma empresa, pronto para o sistema de conversa:
// o bloco do agente, os recursos ligados, a base de conhecimento e um prompt montado.
// Sem travessões nos textos (regra do design system para textos de agente).
import { lerConfig, empresa } from './agentes.js';
import * as conhecimento from './conhecimento.js';

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
    endpoints.push({ metodo: 'GET', caminho: `${base}/conhecimento/buscar?q=ASSUNTO`, descricao: 'busca no conhecimento (preços, horários, regras): devolve só o que interessa' });
    endpoints.push({ metodo: 'GET', caminho: `${base}/conhecimento`, descricao: 'todos os itens de conhecimento (textos, tabelas, documentos)' });
    endpoints.push({ metodo: 'GET', caminho: `${base}/conhecimento/:itemId`, descricao: 'um item' });
  }
  return { empresa: e.nome, reservas: e.modulos.reservas, conhecimento: e.modulos.conhecimento, endpoints };
}

// Acima deste tamanho o prompt não carrega o conhecimento inteiro: a IA consulta pela função de busca.
const LIMITE_PROMPT_CONHECIMENTO = 6000;

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

  if (e.modulos.conhecimento && itens.length) {
    const bloco = [];
    for (const it of itens) {
      if (it.tipo === 'tabela') bloco.push(`\n### ${it.titulo}\n${tabelaMarkdown(it.tabela)}\n`);
      else if (it.tipo === 'texto') bloco.push(`\n### ${it.titulo}\n${it.texto}\n`);
      else bloco.push(`\n### ${it.titulo} (documento ${it.arquivo.nome})\n${it.texto !== undefined ? it.texto : `Arquivo disponível para consulta em ${it.arquivo.url}`}\n`);
    }
    const completo = bloco.join('');
    p += '\n## Base de conhecimento\n';
    if (completo.length <= LIMITE_PROMPT_CONHECIMENTO) {
      p += 'Use estas informações para responder. Se algo não estiver aqui, use a função one_buscar_conhecimento; se mesmo assim não achar, diga que vai confirmar com a equipe e não invente.\n' + completo;
    } else {
      p += 'A empresa tem uma base de conhecimento (preços, horários, regras, documentos). Quando o cliente perguntar sobre preços, produtos, serviços, horários ou regras, chame a função one_buscar_conhecimento com o assunto e responda só com o que ela devolver. Se não achar, diga que vai confirmar com a equipe e não invente.\n';
      p += `Assuntos disponíveis: ${itens.map((it) => it.titulo).join('; ')}.\n`;
    }
  }

  if (e.modulos.reservas) {
    p += `\n## Reservas de mesa
Para reservar: 1) pergunte data, horário, número de pessoas e o ambiente preferido; 2) consulte a disponibilidade antes de oferecer qualquer horário; 3) ofereça ao cliente apenas as mesas livres devolvidas; 4) quando o cliente escolher, registre a reserva; 5) envie também o nome e o contato do cliente quando você os tiver (nomeCliente e contato); 6) só confirme ao cliente depois que o sistema responder "confirmada". Se a resposta for "indisponivel", ofereça as alternativas devolvidas e não prometa mesa.
`;
  }
  return p.trim() + '\n';
}

function contexto(store, empresaId) {
  const e = empresa(store, empresaId);
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

export { contexto, recursosDe, montarPrompt };
