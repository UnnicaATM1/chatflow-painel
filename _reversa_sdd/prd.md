# PRD — ChatFlow Painel: Agentes e Reservas por empresa
> Selo 🟡 PLANEJADO

## Escopo (in) — MVP
1. Config do agente por empresa (descrição, habilidades, produtos, restrições) com permissões de edição por campo.
2. API de leitura autenticada: devolve o bloco completo da config da empresa.
3. API de reserva idempotente com verificação de disponibilidade.
4. Cadastro Empresa → Ambiente → Mesa (capacidade, disponibilidade p/ reservas).
5. Telas: A&B Reservas e Mapa de mesas (painel lateral).
## Não-objetivos
IA de conversa (é do software externo); pagamentos; [INDEFINIDO] demais.
## Requisitos-chave
- RF1 cada empresa tem agente e reservas isolados (empresa_id obrigatório).
- RF2 leitura retorna todos os campos, inclusive os de edição restrita.
- RF3 reserva só confirma após validar mesa livre no horário com capacidade suficiente; sem mesa → retorna alternativas.
- RF4 mesma chave de idempotência = uma reserva.
- RNF autenticação por token; LGPD: guardar mínimo de dados do cliente 🟡.
## Premissas 🟡
Stack não definida (sem stack no projeto): MVP de domínio em Node.js puro sem dependências, persistência em memória atrás de interface. Duração da reserva padrão 90 min 🟡. Alternativas: mesmo horário em outro ambiente, ou horários próximos.
## Métricas
[INDEFINIDO]
