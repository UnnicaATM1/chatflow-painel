# Operações atômicas do repositório (TASK-005)

O contrato vale para o repositório em memória (`src/repositorio.js`), o SQLite e o D1 do Sites. Cada operação abaixo é
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

## Contrato C no D1 (TASK-003)

O Worker instancia `criarStoreD1(env)` com `env.DB` (D1), `env.BUCKET` (R2 privado) e `env.CHATFLOW_FUSO`.
As migrações em `src/d1/migrations/` contêm só schema. A inicial consolida o schema de `db/migrations/0001` e `0002`,
incluindo `reservas.mesa_id` anulável. A segunda adiciona a revisão persistida.

1. O repositório lê a revisão, consulta o estado confirmado e prepara as mutações. A fachada usada pelo núcleo
   calcula as respostas a partir desse estado e dos efeitos preparados. As leituras de uma transação observam o
   estado antes das escritas do lote.
2. A primeira instrução do `batch()` avança a revisão se ela for a mesma. Um `CHECK` nomeado faz o D1 reverter o
   lote se houver concorrência. O callback é repetido com o estado atualizado. Chamadas sem mutação conferem a
   revisão ao terminar. Escritas da aplicação passam pelo repositório. A revisão é global por banco, então a
   contenção entre empresas também pode causar novas tentativas. Sob contenção persistente, a operação devolve 503.
3. O SQL de criação, edição e reativação confirma a mesa e o ambiente e testa a sobreposição na própria instrução
   de escrita. Se a condição não afetar uma linha, o lote é revertido. Os gatilhos do schema também impedem
   sobreposição. A resposta idempotente e o evento da criação HTTP são gravados junto da reserva. Edição,
   cancelamento, reativação, exclusão definitiva e desfazer incluem seu histórico no mesmo lote.

Os testes com D1 local via Miniflare exercitam pedidos simultâneos com chaves iguais e distintas, disputa entre
edição e reativação e falha forçada ao gravar a auditoria. A execução local valida integridade e rollback.
A vazão e as cotas de consultas sob carga precisam de homologação no ambiente hospedado.

O R2 guarda bytes sob `empresas/<empresa>/conhecimento/<uuid>`. O D1 guarda os metadados e a referência. A API de download
aplica a autorização por empresa. O objeto novo é enviado antes de publicar a referência. O lote revertido por
uma restrição confirmada descarta o objeto novo. Versões antigas são descartadas após o commit. Falha de
transporte com resultado indeterminado, interrupção e falha ao apagar no R2 podem deixar órfãos para conciliação posterior.

## O que ainda não é uma operação única (e o risco)

- **Histórico em memória**: as operações e a auditoria são etapas separadas. O núcleo usa a mesma fachada de
  transação para SQLite e D1 nas rotas de reserva, desfazer, remoção de layout e criação de empresa.
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
