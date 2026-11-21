# Revisão do trabalho do T04 (persistência SQL)

TASK-010, revisão feita em 2026-11-21 sobre `db/migrations/0001_inicial.sql` e `src/sqlite/repositorio.js` (repositório em `node:sqlite`, escolhido por `CHATFLOW_BANCO=sqlite`), mais os ajustes de `src/nucleo.js`, `src/node/inicializar.js` e dos testes. Medições com `node:sqlite` (SQLite 3.53) em `tests/migracao-inicial.test.js` e numa sonda local de desempenho. Resultado dos testes: os 56 de `dominio` e `api` passam **com `CHATFLOW_BANCO=sqlite`**, e `npm test` passa 74 de 74.

## 1. O que está certo (verificado)

- Migração reaplicável (`IF NOT EXISTS`), sem dados de demonstração, sem `PRAGMA` no arquivo.
- Histórico append-only: `UPDATE`, `DELETE`, `INSERT OR REPLACE` do mesmo `seq` (inclusive com `recursive_triggers = ON`) e segundo `desfeita` para o mesmo evento são recusados; `seq` sem buraco. Excluir a empresa leva reservas e conhecimento e **mantém** o histórico.
- FKs (`reservas`, `ambientes`, `mesas`, `conhecimento`) e `CHECK` de status funcionam; `UNIQUE (empresa_id, nome_normalizado)` e `(empresa_id, mesa_id)` cobrem `duplicado` e ids de mesa por empresa.
- `idempotencia` combina com `limparIdempotencia`: colunas `empresa_id`, `chave`, `resposta`, `criada_em` (ms) e o índice `(empresa_id, criada_em, id)`. A limpeza usa `id` como desempate (ordem de gravação), igual à memória.

## 2. Achados no esquema (para o T04)

| # | Gravidade | Achado | Sugestão |
|---|---|---|---|
| 1 | Alta | **O banco aceita duas reservas `confirmada` sobrepostas na mesma mesa** (medido: 2 linhas). Só o código protege. No D1 não há transação interativa, então um erro de implementação vira reserva dupla. | Gatilhos `BEFORE INSERT ON reservas` e `BEFORE UPDATE OF status, mesa_id, inicio, fim ON reservas`, com `WHEN NEW.status = 'confirmada' AND EXISTS (mesma empresa e mesa, `confirmada`, outro `id`, `NEW.inicio < fim AND NEW.fim > inicio`)` e `SELECT RAISE(ABORT, 'sobreposicao')`. Defesa em profundidade; o `INSERT ... WHERE NOT EXISTS` continua sendo o caminho normal. O índice parcial `reservas_ocupacao` já serve a esse `EXISTS`. |
| 2 | Alta | `conhecimento.item` guarda o arquivo em base64 no JSON. No D1 o limite de linha é 2 MB e o documento chega a 4 MB (cerca de 5,4 MB em base64). Só funciona no SQLite local. | Item sem bytes; `arquivoChave` do R2 dentro do JSON (ver `persistencia.md`, seção 3). Um teste de contrato com arquivo de 4 MB no repositório SQL deixa a diferença visível. |
| 3 | Média | `idempotencia` **sem FK** para `empresas` (aceita linha órfã, medido). Se `empresaExcluir` esquecer o `DELETE`, a chave de uma empresa excluída fica para sempre. | `REFERENCES empresas(id) ON DELETE CASCADE`, como em `reservas`, ou o `DELETE` obrigatório no `batch` de `empresaExcluir`, com teste. |
| 4 | Média | `empresas.chave` é JSON: `empresaPorChaveHash` faria varredura da tabela com `json_extract` em toda requisição autenticada. | Coluna gerada `chave_hash` (`GENERATED ALWAYS AS (json_extract(chave, '$.hash')) VIRTUAL`) com índice, ou coluna própria. A comparação continua por igualdade do hash de 256 bits. |
| 5 | Média | `empresas.nome` sem unicidade (medido: "A" e "a" convivem). `empresaNomeEmUso` ignora maiúsculas; a corrida entre duas criações passaria. | `nome_normalizado` com `UNIQUE`, como em `ambientes`, ou `UNIQUE (nome COLLATE NOCASE)`. |
| 6 | Média | `historico.evento` (JSON) precisa receber o `seq` **na leitura**: o `INSERT` não conhece o `seq` e o gatilho impede gravá-lo depois. A ordem das chaves do JSON é contrato (JS e Rust). | O repositório monta `{ seq, ...JSON.parse(evento) }` (seq primeiro, como hoje) e `quando` fica dentro do `evento`. Teste de paridade da ordem das chaves. |
| 7 | Baixa | `historico` sem índice por `(empresa_id, entidade, entidade_id, seq)`: o filtro de `historicoListar` por entidade varre o histórico da empresa. | Índice, quando o volume pedir. |
| 8 | Baixa | `reservas.id AUTOINCREMENT` global mantém o vazamento do total de reservas e o id previsível (pendência conhecida do HANDOFF). | `persistencia.md`, seção 5: UUID gerado antes do `INSERT` mais código curto por empresa. Fazer **antes** do primeiro dado real; depois exige migração de dados e mudança de contrato. |
| 9 | Baixa | `reservas.mesa_id` e `reservas.ambiente` não têm FK para `mesas`/`ambientes` (a decisão sobre remover mesa segue aberta no HANDOFF). Hoje é coerente com o código: a reserva sobrevive à mesa. | Manter e documentar. Se a remoção de mesa for decidida, preferir "mesa inativa" a apagar. |
| 10 | Baixa | `tentativas_admin` sem linha inicial. | `INSERT ... ON CONFLICT (id) DO UPDATE` ao gravar, e leitura que trata ausência como `{ n: 0, ate: 0 }`. |
| 11 | Info | Gatilhos com `BEGIN ... END` na migração: confirmar que `wrangler d1 migrations apply` os aceita (a divisão de instruções do D1 já deu problema com gatilhos em alguns caminhos). Não testado aqui (sem conta nem wrangler). | Rodar uma vez em D1 local antes de publicar. |
| 12 | Info | Quem administra o banco pode dar `DROP TRIGGER` (medido). O append-only protege contra o código da aplicação, não contra o administrador. | Registrar que a imutabilidade é garantia da aplicação; o binding do Worker não precisa de DDL em produção. |

## 3. Revisão de `src/sqlite/repositorio.js`

**Paridade de interface: completa.** Os 37 métodos de `criarRepositorioMemoria` existem, todos async, com os mesmos retornos (`{ ok, motivo }`, `{ criada, resposta, reserva }`, `{ conflito }`, `{ antes, mesa }`, evento com `seq` primeiro). Extras: `transacao(fn)` e `fechar()`. A passagem dos 56 testes no modo sqlite confirma. Diferenças que não quebram hoje: o SQL devolve cópias (a memória devolve referências vivas) e a ordem das chaves de `reserva` é `..., status, nomeCliente, contato` (a memória põe `status` por último); só importaria se algum ponto serializasse a reserva crua (o instantâneo `excluida` usa a reserva crua: conferir a ordem no teste diferencial com o Rust).

**Atomicidade.**
- Correto no que promete: `BEGIN IMMEDIATE`, fila por arquivo (`enfileirar`) para não intercalar `await` de duas operações, `busy_timeout` para outro processo, `ROLLBACK` em erro, e o `sink` do histórico só é chamado **depois do COMMIT** (um evento revertido não vai para o arquivo). `empresaExcluir` apaga a empresa, a idempotência (que não tem FK) e grava o evento na mesma transação. `reservaCriar` checa sobreposição e grava reserva e chave juntos. `conhecimentoCriar` usa `UPDATE ... RETURNING` para o id.
- **Não é portável para o D1**: toda operação composta lê, decide em JavaScript e escreve dentro de uma transação aberta entre `await`. No D1 isso não existe (ver `persistencia.md`, seção 3). Está certo como repositório **local**; o repositório D1 será outro arquivo, com `INSERT ... WHERE NOT EXISTS` e `batch`. Registrar no cabeçalho do arquivo que ele não é a versão D1.
- `repositorio.transacao` é usado só por `desfazer` (`src/nucleo.js:69`). A lacuna "mudança de reserva e evento de histórico em passos separados" (`docs/atomicidade.md`) **continua aberta** em `mudarReserva`/criação: a infraestrutura já existe, falta usá-la lá.
- `reservaCancelar` e `conhecimentoExcluir` são instruções únicas fora de `transacionar`: corretas. `reservaCancelar` de reserva inexistente devolve `null` (a memória lança); o serviço já confere antes, sem efeito prático.

**Histórico.** Nenhum `UPDATE`/`DELETE` em `historico` no código (`grep` vazio); `empresaExcluir` não toca o histórico; `seq` vem de `lastInsertRowid` e a leitura monta `{ seq, ...JSON.parse(evento) }`, na mesma ordem da memória (resolve o achado 6 do esquema).

**Achados no repositório.**

| # | Gravidade | Achado | Sugestão |
|---|---|---|---|
| R1 | Alta | `lerEmpresa` carrega **toda** a base de conhecimento (com os arquivos em base64) em **cada** `empresaObter`/`empresaListar`. Medido: 5 documentos de 4 MB, 34 ms por `empresaObter`; com os 200 itens permitidos seriam segundos por requisição. Nenhum serviço lê `empresa.conhecimento` (todos usam `conhecimentoListar`). É o mesmo erro que o Rust já corrigiu (HANDOFF, aprendizados do Rust). | `lerEmpresa` sem `conhecimento` (ou `conhecimento: []` fixo) e sem o arquivo; `conhecimentoListar/Obter` continuam lendo a tabela. Confirmar com `grep` que nada usa `empresa.conhecimento`. |
| R2 | Média | A migração só roda se `user_version === 0` e o caminho é fixo em `0001_inicial.sql`. Uma `0002` nunca seria aplicada. | Ler `db/migrations/*.sql` em ordem e aplicar as de número maior que `user_version`, cada uma na própria transação, gravando `user_version = N`. |
| R3 | Média | `empresaNomeEmUso` lê todas as empresas e compara em JavaScript; sem unicidade no banco (achado 5 do esquema). Local é seguro pela fila; no D1 não. | `UNIQUE` em `nome_normalizado` e consulta direta `WHERE nome_normalizado = ?`. |
| R4 | Média | `empresaPorChaveHash` varre as empresas fazendo `JSON.parse` de cada `chave` em toda requisição autenticada (achado 4 do esquema). | Coluna gerada com índice e busca por igualdade, mantendo `iguaisTempoConstante` na confirmação. |
| R5 | Baixa | `idemGravar` roda `limparIdempotencia` (com o teto) a cada gravação. Medido: 0,31 ms por gravação com 10000 entradas no teto; aceitável. Sobe se o teto crescer. | Deixar assim; se o teto passar de dezenas de milhares, limpar a cada N gravações. |
| R6 | Baixa | Sem `PRAGMA journal_mode = WAL`: leitores bloqueiam durante a escrita se houver mais de um processo no mesmo arquivo. | `PRAGMA journal_mode = WAL` ao abrir arquivo (não em `:memory:`). |
| R7 | Baixa | `empresaCriar` com id existente faz `ON CONFLICT DO UPDATE` e apaga ambientes e conhecimento, mas **não** reservas nem idempotência. Coerente com a memória (`empresas.set` troca a empresa e mantém as reservas), mas só serve a semente de demonstração. | Comentar no código que é semente e não recriação. |
| R8 | Info | `mesaCriar` escolhe o próximo id em JavaScript (sem `UNIQUE` + nova tentativa). Seguro aqui; no D1 exige a nova tentativa. | Anotar para o repositório D1. |

## 4. Resultado

- **Esquema: aprovado com ressalvas.** Tratar os achados 1 a 3 antes de portar para o D1; 4 a 6 junto com o repositório D1.
- **Repositório local (`node:sqlite`): aprovado como implementação local**, com **R1 a corrigir já** (custo por requisição cresce com o conhecimento) e R2 a corrigir antes da segunda migração. Paridade de interface e ausência de `UPDATE/DELETE` no histórico: confirmadas.
- **Atomicidade para o D1: não atendida e não era o escopo** deste arquivo; fica para `src/d1/repositorio.js` seguindo `persistencia.md`.

## 5. Revisão final (2026-11-21, depois das correções do T04)

Reaplicadas as sondas sobre o `0001_inicial.sql` final (SQLite 3.53), e a migração aplicada duas vezes sem erro.

| Achado | Status | Medição |
|---|---|---|
| 1 Reservas sobrepostas | **Corrigido** | INSERT sobreposto, reativação sobreposta e edição de horário sobreposta abortam com `sobreposicao de reservas`; adjacente (190 após 100–190), outra mesa, reserva cancelada sobreposta e editar a própria reserva passam. |
| 3 `idempotencia` sem FK | **Corrigido** | Linha de empresa inexistente: `FOREIGN KEY constraint failed`; apagar a empresa leva suas chaves (0 linhas restantes). |
| 4 `empresas.chave` sem índice | **Corrigido** | Coluna gerada `chave_hash`; `EXPLAIN QUERY PLAN`: `SEARCH empresas USING INDEX empresas_por_chave_hash (chave_hash=?)`. |
| 5 Nome da empresa sem unicidade | **Corrigido** | `b` depois de `B` recusado (`UNIQUE ... empresas.nome`); dois nomes com o mesmo `nome_normalizado` recusados. Ressalva: `COLLATE NOCASE` só dobra ASCII, o resto depende do `nome_normalizado` que o repositório preenche; inserção SQL direta com acento e `nome_normalizado` NULL passaria (NULLs não colidem em `UNIQUE`). Aceitável, pois só o repositório escreve. |
| 6 Ordem do histórico | **Corrigido** | Memória e SQLite devolvem as mesmas chaves, na mesma ordem, tanto no `historicoAcrescentar` quanto no `historicoListar`: `seq, boot, quando, empresaId, entidade, entidadeId, acao, papel, depois`. |
| 10 `tentativas_admin` sem linha | **Corrigido** | Sem linha: `{ n: 0, ate: 0 }`; depois de gravar: `{ n: 2, ate: 5 }`, idêntico à memória. |

Não verificados por falta de ferramenta: achado 11 (`wrangler d1 migrations apply` com os gatilhos, agora com dois gatilhos a mais) segue pendente. Achados 2, 7, 8, 9 e 12 permanecem como documentados; R1 a R8 do repositório não foram reavaliados nesta etapa.

Testes: `npm test` com `CHATFLOW_BANCO=memoria` e com `CHATFLOW_BANCO=sqlite`: 80 de 80 em cada.
