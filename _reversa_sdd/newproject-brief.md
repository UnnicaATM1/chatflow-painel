# Brief inicial, /reversa-new

> Selo 🟡 PLANEJADO.

**Data:** 2026-11-14
**Usuário:** João

## Ideia original
Módulo do Kendji ONE para restaurantes com 3 lojas. Cada loja tem seu próprio agente de atendimento (config em Atendimento → Agentes) e suas próprias reservas (A&B → Reservas e Mapa de mesas). Um software externo de conversa lê a configuração do agente a cada mensagem (API autenticada, somente leitura, bloco inteiro) e registra reservas por chamada separada (idempotente; só confirma ao cliente após o resultado). Cadastro Loja → Ambiente → Mesa em A&B → Configuração.

## Restrições de integração (dadas pelo usuário)
- Leitura da config: API autenticada de leitura, devolve descrição, habilidades, produtos e restrições em uma resposta, incluindo campos de edição reservada à equipe de integração.
- Reserva: loja, data, horário, pessoas, ambiente preferido opcional; Kendji ONE valida disponibilidade; indisponível → chat oferece outra opção; reenvio gera uma única reserva.
- Quem edita cada campo é definido pela equipe de integração.
