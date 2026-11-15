# Operações atômicas do repositório (TASK-005)

Hoje o repositório é em memória (`src/repositorio.js`) e o Node roda um pedido de cada vez entre dois `await`, mas o
contrato foi escrito para o D1 do Sites, onde duas requisições podem chegar ao mesmo tempo. Cada operação abaixo é
**uma função do repositório** que deve ser tudo-ou-nada. No D1, cada uma vira uma transação ou um `batch` de
instruções com condição (`INSERT ... WHERE NOT EXISTS (...)`, `UPDATE ... WHERE ...`) e confere o número de linhas afetadas.

Regra para quem escrever a versão D1: o serviço (`src/reservas.js` etc.) faz a leitura e a decisão; a operação atômica
**refaz a checagem que importa dentro da transação**. A leitura do serviço é só uma sugestão; quem manda é a operação.

| Operação | O que garante | Como o D1 deve garantir |
|---|---|---|
| `reservaCriar({ empresaId, chave, candidatas, reserva })` | (1) se a chave de idempotência já tem resposta, devolve a mesma e não cria nada; (2) insere a reserva na **primeira** mesa candidata sem sobreposição (`inicio < fim_existente AND fim > inicio_existente`, só reservas `confirmada`, só aquela mesa); (3) grava a resposta da chave na mesma transação; (4) se todas as candidatas foram tomadas, devolve `{ conflito: true }` e não grava nada. | Transação: `SELECT` da chave; para cada candidata `INSERT ... WHERE NOT EXISTS (reserva sobreposta)`; `INSERT` da chave com `UNIQUE (empresa_id, chave)`. Se a inserção da chave falhar por duplicidade, refazer a leitura e devolver a resposta já gravada. |
| `reservaEditar({ empresaId, id, dados, cliente })` | Muda pessoas, data, horário, mesa e dados do cliente rechecando a sobreposição **ignorando a própria reserva**. `{ ok: false, motivo: 'conflito' }` se a mesa nova já está ocupada no novo horário. | `UPDATE reservas SET ... WHERE id = ? AND empresa_id = ? AND status = 'confirmada' AND NOT EXISTS (outra reserva sobreposta na mesa)`; 0 linhas afetadas = conflito. |
| `reservaCancelar(empresaId, id)` | Marca `cancelada` (libera a mesa). Idempotente. | `UPDATE ... SET status = 'cancelada'`. |
| `reservaReativar(empresaId, id)` | Volta a `confirmada` só se a mesa ainda está livre no horário original (rechecagem). Já confirmada: devolve a reserva sem mudar. | `UPDATE ... SET status = 'confirmada' WHERE ... AND NOT EXISTS (sobreposição)`; 0 linhas = conflito. |
| `conhecimentoCriar(empresaId, item, max)` | Id sequencial por empresa e limite de itens sem corrida (duas criações simultâneas não repetem id nem passam do limite). | Transação com `UPDATE empresas SET prox_conhecimento = prox_conhecimento + 1 ... RETURNING` e `INSERT` condicionado à contagem. O arquivo (base64 hoje) vai para o R2 antes, com a chave guardada na linha. |
| `mesaCriar(empresaId, ambiente, ...)` | Escolhe o próximo id livre (`S1`, `S2`...) sem repetir em criações simultâneas. | `UNIQUE (empresa_id, mesa_id)` e nova tentativa se a inserção falhar. |
| `ambienteCriar(empresaId, nome)` | Nome único por empresa, sem diferenciar maiúsculas. | `UNIQUE (empresa_id, nome COLLATE NOCASE)`; falha de unicidade = `duplicado`. |
| `empresaExcluir(id, evento)` | Apaga a empresa com tudo (reservas, chaves de idempotência, conhecimento, chave de API) **e** grava o evento de auditoria `excluida` junto: ou os dois acontecem, ou nenhum. | `batch` com os `DELETE` e o `INSERT` do evento; arquivos do R2 apagados depois (limpeza assíncrona tolerante a falha). |
| `historicoAcrescentar(ev)` | Só acrescenta; `seq` crescente sem buracos nem repetição. | `INSERT` com `seq INTEGER PRIMARY KEY AUTOINCREMENT`; a tabela não tem `UPDATE` nem `DELETE` (gatilho que bloqueia). |

## O que ainda não é uma operação única (e o risco)

- **Desfazer** (`desfazer` em `src/nucleo.js`): lê o evento, confere que não foi desfeito e que a reserva não mudou depois,
  aplica a operação (`reservaCancelar`, `reservaReativar` ou `reservaEditar`, cada uma atômica) e grava o evento `desfeita`.
  São passos separados. Em memória, dois "desfazer" simultâneos do mesmo evento são raros e o segundo costuma falhar na
  conferência de mudanças posteriores. No D1, fechar a lacuna com `UNIQUE (empresa_id, ref_seq) WHERE acao = 'desfeita'`
  no histórico: o segundo evento falha e o pedido responde 409.
- **Mudança de reserva + histórico** (`mudarReserva`): a reserva muda e o evento é gravado em seguida. Se o processo cair
  entre os dois, a mudança existe sem rastro. No D1, juntar os dois em um `batch`.
- **Resposta "indisponivel" idempotente**: `idempotenciaGravar` é uma gravação à parte (não cria reserva). Duas chamadas
  simultâneas com a mesma chave podem ambas calcular "indisponivel"; as duas respondem o mesmo conteúdo, então é inofensivo.
- **Bloqueio por senha errada do administrador** (`tentativasAdminObter/Gravar`): leitura e gravação separadas; em ambiente
  distribuído pode deixar passar algumas tentativas além de 5. Para o D1/KV, usar incremento atômico.
- **Limite de requisições**: fica na memória de cada instância. Num Worker cada instância conta separado; para valer de
  verdade é preciso contador compartilhado (Durable Object ou KV com TTL). Fora do escopo desta tarefa.

## Onde cada operação é chamada

| Operação | Serviço / rota |
|---|---|
| `reservaCriar`, `idempotenciaObter/Gravar` | `reservarDetalhado` em `src/reservas.js` (`POST /empresas/:id/reservas`) |
| `reservaEditar`, `reservaCancelar`, `reservaReativar` | `src/reservas.js` (`PATCH`/`DELETE /empresas/:id/reservas/:rid`, desfazer) |
| `conhecimentoCriar/Editar/Excluir` | `src/conhecimento.js` (`/empresas/:id/conhecimento`) |
| `mesaCriar`, `mesaEditar`, `ambienteCriar` | `src/nucleo.js` (`POST /empresas/:id/mesas`, `PATCH .../mesas/:mesaId`, `POST .../ambientes`) |
| `empresaExcluir` | `src/nucleo.js` (`POST /empresas/:id/excluir`) |
