# Persistência do ChatFlow Painel: de memória para SQLite, D1 e R2

TASK-010. Este documento descreve como cada estrutura em memória de `src/repositorio.js` vira tabela, como o mesmo SQL
sobe para o D1 e o R2 do Cloudflare e o que muda na atomicidade. A seção de LGPD traz **propostas**: a decisão é do João.
Nomes de tabela e coluna seguem `db/migrations/0001_inicial.sql` (T04); onde este texto e o arquivo divergirem, vale o arquivo. A revisão desse esquema está em [revisao-persistencia-t04](revisao-persistencia-t04.md).

Complementa [atomicidade](atomicidade.md) (o que cada operação garante) e [portabilidade-worker](portabilidade-worker.md) (o que muda no runtime).

## 1. Mapa: estrutura em memória para tabela

O repositório devolve objetos aninhados (empresa com `ambientes[].mesas[]` e `conhecimento[]`). No SQL, o aninhado vira tabela filha. Toda tabela leva `empresa_id` e toda consulta o usa: é o que isola uma empresa da outra.

| Em memória (`criarRepositorioMemoria`) | Tabela SQLite/D1 (`0001_inicial.sql`) | Colunas e observações |
|---|---|---|
| `empresas: Map` (`id`, `nome`, `agente`, `modulos`, `chave`, `proxConhecimento`) | `empresas` | `id` (PK), `nome` (`COLLATE NOCASE UNIQUE`: o banco recusa nomes iguais sem diferenciar maiúsculas ASCII), `nome_normalizado` (`UNIQUE`, minúsculas Unicode preenchidas pelo repositório), `agente` (JSON), `modulos` (JSON), `chave` (JSON `{hash, prefixo, criadaEm}` ou NULL), `chave_hash` (coluna gerada `json_extract(chave, '$.hash')`, índice `empresas_por_chave_hash`: a autenticação busca por igualdade, sem varrer a tabela), `prox_conhecimento`. O agente fica em JSON porque nunca é consultado por campo. Só o hash da chave de API é guardado. |
| `empresa.ambientes[]` | `ambientes` | `id` (rowid), `empresa_id` (FK com `ON DELETE CASCADE`), `nome`, `nome_normalizado` com `UNIQUE (empresa_id, nome_normalizado)` (garante o `duplicado` de `ambienteCriar`). |
| `ambientes[].mesas[]` | `mesas` | `ordem` (rowid, preserva a ordem de criação), `empresa_id`, `ambiente_id`, `mesa_id` (`S1`, `E2`: único só dentro da empresa, `UNIQUE (empresa_id, mesa_id)`), `capacidade`, `reservavel` (0/1). FK composta `(empresa_id, ambiente_id)`. |
| `reservas: []` | `reservas` | `id` (`AUTOINCREMENT`, ver seção 5), `empresa_id` (FK), `mesa_id`, `ambiente`, `data`, `horario`, `pessoas`, `inicio`, `fim` (minutos absolutos), `status` (`CHECK` em `confirmada`/`cancelada`), `nome_cliente`, `contato` (dado pessoal, ver seção 4). Índice parcial `reservas_ocupacao (empresa_id, mesa_id, inicio, fim) WHERE status = 'confirmada'` para a checagem de sobreposição. **O próprio banco recusa a sobreposição**: gatilhos `reservas_sem_sobreposicao_insert` e `reservas_sem_sobreposicao_update` (`BEFORE UPDATE OF status, mesa_id, inicio, fim, empresa_id`) abortam com `sobreposicao de reservas` quando uma reserva `confirmada` cruza outra `confirmada` da mesma mesa (adjacentes, outra mesa e canceladas passam). O `INSERT ... WHERE NOT EXISTS` continua sendo o caminho normal e o gatilho é a rede de segurança. |
| `idempotencia: Map(empresaId -> Map(chave -> { resposta, quando }))` | `idempotencia` | `id` (`AUTOINCREMENT`, ordem de gravação, desempate do teto), `empresa_id` (FK com `ON DELETE CASCADE`), `chave`, `resposta` (JSON), `criada_em` (ms), `UNIQUE (empresa_id, chave)` (fecha a corrida), índice `(empresa_id, criada_em, id)`. Limpeza por validade e teto: `src/sqlite/idempotencia-limpeza.js`. |
| `empresa.conhecimento[]` | `conhecimento` | `(empresa_id, id)` PK (id sequencial por empresa, vindo de `empresas.prox_conhecimento`), `item` (JSON do item: tipo, título, texto, tabela, metadados do arquivo). No D1 o arquivo **não** fica em `item` (ver seção 3). |
| `historico: []` | `historico` | `seq` (`AUTOINCREMENT`), `empresa_id`, `entidade`, `entidade_id`, `acao`, `ref_seq`, `evento` (JSON com quando, papel, operador, antes e depois). **Sem `UPDATE` nem `DELETE`** (gatilhos `BEFORE UPDATE`, `BEFORE DELETE` e proteção contra `INSERT OR REPLACE`); `UNIQUE (empresa_id, ref_seq) WHERE acao = 'desfeita'` fecha o desfazer duplo. Não tem FK para `empresas`: excluir a empresa não apaga o histórico (ver seção 4). O `seq` real é o da coluna: na leitura, montar `{ seq, ...JSON.parse(evento) }`, porque o banco só dá o número depois do `INSERT` e o gatilho impede gravá-lo no JSON depois. O `boot` (UUID do processo) deixa de fazer sentido. |
| `tentativasAdmin { n, ate }` | `tentativas_admin` | Linha única (`id = 1`, `CHECK`). Gravar com `INSERT ... ON CONFLICT (id) DO UPDATE`; incrementar com `UPDATE ... SET n = n + 1`. |
| Limite de requisições (em `src/nucleo.js`, por instância) | ver seção 3 | Não é tabela do repositório. |

Observações de modelagem:

- **`empresaProximoId`** hoje confere o histórico para nunca reaproveitar `empresa_N` de empresa excluída. No SQL a mesma conferência é uma consulta em `historico (empresa_id, seq)`; sob concorrência duas criações podem escolher o mesmo número, e a PK de `empresas` recusa a segunda (repetir com o próximo). Não use `COUNT(*) + 1`.
- **`empresaExcluir`** apaga `empresas` e o `ON DELETE CASCADE` leva `ambientes`, `mesas`, `reservas` e `conhecimento`. `idempotencia` também tem FK com `CASCADE`, então o `DELETE` explícito dela deixa de ser necessário (o repositório SQLite ainda o faz, sem prejuízo). O `historico` também fica de fora do cascade (ver seção 4, tensão com o direito de apagar).
- **Índice do histórico**: se o filtro por entidade ficar lento, criar índice `(empresa_id, entidade, entidade_id, seq)` (achado 7 da revisão).
- **Reserva sem FK para mesa e ambiente**: `reservas.mesa_id` e `reservas.ambiente` são texto sem chave estrangeira, para a reserva sobreviver à mesa. Se a remoção de mesa for decidida, preferir "mesa inativa" a apagar (achado 9).
- **Gatilhos na migração (D1)**: confirmar uma vez com `wrangler d1 migrations apply` local que os gatilhos com `BEGIN ... END` são aceitos (achado 11). O append-only é garantia da aplicação: quem administra o banco pode dar `DROP TRIGGER`, então o binding do Worker não deve ter permissão de DDL em produção (achado 12).
- **Datas** continuam em minutos absolutos sem fuso (`src/tempo.js`): são `INTEGER`, a comparação de sobreposição é aritmética e funciona igual em qualquer motor.
- **JSON em coluna**: no D1 vale `TEXT` com `json_valid` em `CHECK`. Não criar índice sobre dentro do JSON enquanto ninguém consultar por ele.
- `PRAGMA foreign_keys = ON` precisa ser ligado por conexão no SQLite local; o D1 mantém ligado.

## 2. Caminho para o D1

O SQL da migração deve ser SQLite padrão, igual no `node:sqlite` (testes e desenvolvimento) e no D1 (produção).

1. **Migrações**: `db/migrations/NNNN_nome.sql`, numeradas, imutáveis depois de aplicadas, sem `CREATE TABLE` durante requisição e sem dados de demonstração. Uma publicação que falha pode já ter aplicado o esquema: a migração seguinte corrige, não reescreve a anterior.
2. **Interface**: `src/d1/repositorio.js` exporta `criarRepositorioD1({ db, bucket, plat, sink })` com **as mesmas funções** de `criarRepositorioMemoria`, todas já `async`. O núcleo e os serviços não mudam. O teste de contrato (os 56 testes de `tests/`) deve rodar contra os dois repositórios; `node:sqlite` serve de banco para a versão SQL sem depender da conta Cloudflare.
3. **Diferença de API**: `node:sqlite` é síncrono (`prepare(sql).run(...)`), o D1 é assíncrono (`prepare(sql).bind(...).run()`, `batch([...])`). Escreva o repositório contra um pequeno adaptador `executar`/`lote` com as duas implementações, como já faz `src/sqlite/idempotencia-limpeza.js` (detecta `bind`).
4. **Uma instrução por `prepare()`**: o D1 não aceita várias instruções separadas por `;` num `prepare`. Vários passos viram `batch`.
5. **Dados atuais**: o ONE em produção ainda não existe com clientes reais; a migração de dados é exportar o que importa (empresas, chaves, reservas, conhecimento) do instantâneo e importar por script. Não derive o estado do arquivo `CHATFLOW_HISTORICO_ARQUIVO`: ele guarda só eventos e não reconstrói empresas nem reservas.
6. **Limpeza de idempotência**: o `UNIQUE (empresa_id, chave)` cresce sem limite se ninguém limpar. Rodar `limparIdempotencia(db, { ttlMs, max })` (24 h e 10000 por empresa, os mesmos padrões da memória) em tarefa agendada (Cron Trigger) e, de forma barata, de vez em quando durante `reservaCriar` (por exemplo, a cada N gravações da empresa). A leitura da chave **também** deve descartar o vencido (`WHERE criada_em > agora - ttl`), então a limpeza é só higiene de espaço; a correção do contrato não depende dela.

## 3. R2, limite compartilhado e atomicidade no D1

### Arquivos do conhecimento no R2

- Os bytes do documento (até 4 MB) saem do banco. Hoje ficam em base64 dentro do item, em memória. No D1, o `item` JSON da linha de `conhecimento` guarda só os metadados do arquivo e `arquivoChave` (e a linha do D1 tem limite de 2 MB: um documento de 4 MB em base64 nem caberia).
- Chave opaca e por empresa: `empresas/{empresa_id}/conhecimento/{uuid}`. O nome original do arquivo fica no D1 e no cabeçalho `Content-Disposition`, **nunca** na chave. O bucket **não** é público: o download passa pela API (autorização, `nosniff`, `CSP sandbox`, MIME vindo da tabela), como hoje.
- **R2 e D1 não formam uma transação.** Ordem proposta: (1) gravar o objeto no R2, (2) gravar a linha no D1 com `arquivo_chave`. Se o passo 2 falha, sobra objeto órfão: tolerável e removível por varredura periódica (objetos sem linha correspondente com mais de 1 hora). Na exclusão do item ou da empresa: apagar a linha primeiro, o objeto depois, e tolerar falha do segundo (também varrido). Nunca apagar o objeto antes da linha: quebraria o download de um item que ainda existe.
- A extração de texto do PDF, Word e Excel (pendência do HANDOFF) é independente: pode acontecer na criação e gravar `texto` na tabela.

### Limite de requisições compartilhado

Hoje os baldes (20 falhas de chave por IP por minuto, 300 chamadas por chave válida por minuto) vivem em `Map` por instância. Num Worker, cada isolate conta separado, então o limite real é maior que o configurado e não há como prever quanto. Opções, em ordem de preferência para o Sites:

1. **Tabela `limites(chave, janela, n)` no D1** com `INSERT ... ON CONFLICT (chave, janela) DO UPDATE SET n = n + 1 RETURNING n`: incremento atômico, uma ida ao banco por requisição, limpeza por janela vencida. Custa uma escrita por requisição; medir antes de adotar.
2. **Durable Object por chave** (contagem exata, sem ida ao banco), se o Sites passar a oferecer o binding. Não está confirmado hoje.
3. **Limitador nativo da plataforma**, se existir, para a camada grossa; manter o balde por empresa no D1.

O mesmo contador atômico resolve `tentativasAdmin` (senha do administrador).

### O que muda na atomicidade em D1

No `node:sqlite` dá para abrir `BEGIN ... COMMIT`, ler no meio e decidir (transação interativa). **No D1 isso não existe**: não há transação aberta entre duas chamadas `await`. A atomicidade vem de duas ferramentas:

- **Instrução única condicional**: `INSERT ... SELECT ... WHERE NOT EXISTS (...)` e `UPDATE ... WHERE ... AND NOT EXISTS (...)`. O banco decide e escreve de uma vez; confere-se `meta.changes` (0 = conflito).
- **`batch([...])`**: várias instruções executadas numa transação implícita, todas ou nenhuma, **sem** poder ler o resultado de uma para montar a seguinte. Todo valor que a instrução 2 precisa da instrução 1 tem de vir de subconsulta (`(SELECT ... )`) ou ser gerado antes (UUID, `agora`).

Consequências para cada operação (complementa a tabela de [atomicidade](atomicidade.md)):

| Operação | Versão com transação interativa (SQLite local) | Versão para D1 (`batch` e instruções condicionais) |
|---|---|---|
| `reservaCriar` com várias candidatas | laço: tenta uma, se `changes = 0` tenta a próxima, tudo na transação | Um `INSERT` por candidata, na ordem, **cada um condicional**, e a gravação da chave de idempotência condicionada a "alguma reserva foi inserida". Como não dá para o laço decidir no meio, ou se envia **um batch com todas as candidatas** (cada `INSERT ... WHERE NOT EXISTS (sobreposição) AND NOT EXISTS (reserva já inserida por este pedido)`) ou se faz uma ida ao banco por candidata. A segunda é mais simples e aceitável: a atomicidade que importa é a de cada `INSERT` (sem sobreposição por mesa); o pedido todo não precisa ser uma transação. |
| Chave de idempotência junto da reserva | `INSERT` da chave dentro da mesma transação | A resposta (`reservaId`, mesa) só existe depois do `INSERT` da reserva. No `batch`, montar a resposta por subconsulta (`INSERT INTO idempotencia SELECT ... FROM reservas WHERE rowid = last_insert_rowid()`) ou, mais simples, usar **UUID gerado antes** como `id` da reserva e escrever a resposta já completa. Isso é mais um motivo para a troca do id (seção 5). |
| `reservaEditar` + evento de histórico | uma transação | `batch([UPDATE reservas ... WHERE ... AND NOT EXISTS (...), INSERT INTO historico ... WHERE changes() > 0])`: o evento só entra se o `UPDATE` alterou linha (`changes()` do SQLite vale na mesma transação). Fecha a lacuna "reserva muda sem rastro". |
| `empresaExcluir` | transação | `batch` com os `DELETE` e o `INSERT` do evento `excluida` (já previsto). O instantâneo do evento é lido **antes** do `batch`; se algo mudou no meio, o instantâneo fica levemente defasado (aceitável, a exclusão é rara e feita por administrador). |
| `conhecimentoCriar` (id e limite) | transação com `UPDATE ... RETURNING` | Uma instrução: `INSERT INTO conhecimento SELECT (SELECT prox_conhecimento FROM empresas WHERE id = ?), ... WHERE (SELECT COUNT(*) FROM conhecimento WHERE empresa_id = ?) < ?`, seguida (no mesmo `batch`) do `UPDATE empresas SET prox_conhecimento = prox_conhecimento + 1 WHERE changes() > 0`. Alternativa: `UNIQUE (empresa_id, id)` e repetir com o próximo id se a inserção falhar. |
| Desfazer | leitura, conferência, operação, evento | Leitura e conferência continuam fora; a operação e o evento `desfeita` vão no mesmo `batch`, com o `UNIQUE (empresa_id, ref_seq) WHERE acao = 'desfeita'` como trava final: o segundo desfazer falha e responde 409. |

Regra que continua valendo: o serviço lê e sugere; **a instrução condicional refaz a checagem que importa**. No D1, "ler e depois escrever" em chamadas separadas nunca é seguro por si só.

Primeira prova técnica a fazer antes de comprometer prazo: duas reservas simultâneas para a mesma mesa e horário, contra `wrangler d1` local, exigindo exatamente uma vencedora.

## 4. LGPD: proposta (decisão do João)

**Dado pessoal hoje**: `nome_cliente` (até 80 caracteres) e `contato` (telefone ou e-mail, até 40) em `reservas`. O **histórico copia esses dados** em `antes`/`depois` de eventos de reserva (`criada`, `editada`, `desfeita`) e no instantâneo do evento `excluida` da empresa. Há ainda o operador digitado no login (`X-Operador`), que pode ser um nome de pessoa. A chave de API e a senha do administrador não são dado pessoal; seguem em tratamento de segredo.

**Papéis**: a empresa cliente (restaurante, oficina) é a **controladora** dos dados dos seus clientes; o ChatFlow Painel é **operador** (trata em nome da empresa). Isso precisa constar em contrato ou termo de uso com a empresa. Confirmar com o jurídico antes de usar com clientes reais.

### Propostas

| Tema | Proposta | Alternativa |
|---|---|---|
| **Base legal** | Execução de contrato ou procedimentos preliminares (art. 7º, V): o cliente pede a reserva e o dado é necessário para honrá-la. Não pedir consentimento só para isso. | Legítimo interesse, se a empresa quiser usar o contato para outra finalidade (aí exige avaliação própria). |
| **Retenção em `reservas`** | Guardar nome e contato **até 90 dias depois da data da reserva**; depois, **anonimizar** (`nome_cliente = NULL`, `contato = NULL`) mantendo a reserva para estatística de ocupação. Rotina diária, mesma natureza da limpeza de idempotência. | 30 dias (mais protetivo), ou prazo configurável por empresa em `empresas`. |
| **Retenção no histórico** | Eventos de reserva guardam **só campos não pessoais** (ou o contato mascarado, `***1234`) a partir de agora; ver "histórico versus apagar". | Manter completo por 90 dias e anonimizar junto. |
| **Apagamento a pedido do titular** | Endpoint de equipe/integração `POST /empresas/:id/titulares/apagar {contato}` que (1) anonimiza `reservas` com aquele contato, (2) anonimiza o JSON dos eventos correspondentes (ver abaixo), (3) grava um evento `titular_apagado` **sem** o dado apagado, só a data e a contagem de linhas afetadas. Prazo de atendimento: 15 dias (art. 19, II). | Atendimento manual por script documentado enquanto não houver endpoint. |
| **Direito de acesso e portabilidade** | Mesma busca por `contato`, devolvendo as reservas do titular em JSON. | Exportação manual pela equipe. |
| **Exclusão de empresa** | Hoje o instantâneo de `excluida` leva reservas **com** nome e contato. Proposta: instantâneo **sem** nome e contato do cliente (só ocupação). | Guardar completo por 90 dias e anonimizar. |
| **Operador (`X-Operador`)** | Tratar como dado pessoal de **funcionário**; manter por 5 anos para auditoria (prazo a validar), sem vincular a documento. Quando houver token por usuário, trocar o nome por id de usuário. | |
| **Logs e backups** | Backup do banco entra no prazo: anonimização em produção só vale depois que o backup antigo expirar (30 dias propostos). Não gravar nome e contato em logs de requisição. | |

### Histórico append-only versus direito de apagar

Há uma tensão real: o histórico é **imutável por desenho** (gatilhos bloqueiam `UPDATE` e `DELETE`; é a trilha de auditoria) e a LGPD dá ao titular o direito de eliminar ou anonimizar. Três saídas, da mais limpa para a mais custosa:

1. **Não pôr dado pessoal no histórico** (recomendada). O evento de reserva registra `mesa`, `data`, `horario`, `pessoas`, `status` e um **indicador** de que nome/contato mudaram (`cliente_alterado: true`), mas nunca o valor. O direito de apagar fica restrito a `reservas`, e o histórico continua imutável sem conflito. Custo: o "desfazer" de uma edição que só mudou o contato perderia o valor anterior; aceitável (desfazer de dado pessoal pode ser recusado).
2. **Pseudonimização**: o histórico guarda `titular_ref` (HMAC do contato com um segredo da empresa) em vez do contato. Permite achar os eventos de um titular sem expor o dado; apagar passa a ser **destruir o segredo da empresa** (crypto-shredding), o que torna os rastros irrecuperáveis sem tocar a tabela. Custo: gestão de segredo por empresa.
3. **Anonimização controlada por exceção**: permitir um `UPDATE` só em `antes`/`depois` e só por uma rotina nomeada (gatilho que libera apenas a coluna e grava o fato). Custo: o histórico deixa de ser estritamente "sem UPDATE", o que enfraquece a garantia e exige revisão a cada mudança do gatilho. **Não recomendo.**

O que o histórico **pode** manter sem problema: quem fez (papel), quando, o que mudou em dados não pessoais e o `seq`.

### Pendências de decisão (ao João)

- Prazos: 90 dias de retenção em reservas, 5 anos de operador, 30 dias de backup (ajustar).
- Saída 1, 2 ou 3 para o histórico (a 1 é a mais simples e segura).
- Quem atende o titular: a empresa, o ChatFlow, ou ambos (e canal de contato).
- Se a empresa terá prazo próprio configurável.
- Política de privacidade e termo com a empresa controladora (fora do código).

## 5. Troca do `reservaId` global

Hoje `reservaId` é `++seqReserva`, um contador **global**. Problemas: (a) vaza o total de reservas entre empresas (a empresa 2 vê que o id saltou de 10 para 5000); (b) permite **enumerar** reservas de outras empresas por tentativa (a API confere a empresa, mas o id previsível ajuda em ataque e em erro de uso); (c) em D1, o contador em memória deixa de existir e o `seqReserva` zera a cada reinício; (d) obriga ler o id gerado depois do `INSERT` (`last_insert_rowid`), que não cabe num `batch` que já precisa da resposta pronta.

**Recomendação: UUID v4 gerado pela plataforma antes do `INSERT`** (`plat.uuid()`, já existe), como `reservas.id TEXT PRIMARY KEY`, ou, se o João preferir um número curto para mostrar ao atendente, **id por empresa** (`UNIQUE (empresa_id, numero)`, com `numero` vindo de `empresas.prox_reserva` incrementado atomicamente, como já é o conhecimento).

| | UUID | Número por empresa |
|---|---|---|
| Vaza total entre empresas | não | não |
| Enumerável | não | sim dentro da empresa (já é autorizado) |
| Curto para falar no telefone | não (36 caracteres) | sim |
| Cabe em `batch` sem ler o id | sim (gerado antes) | exige subconsulta ou `UPDATE ... RETURNING` |
| Mudança no contrato HTTP | `reservaId` vira string | `reservaId` continua inteiro |

Melhor combinação: **UUID como chave interna e exposta na API, mais um `codigo` curto por empresa** (por exemplo `R-0042`) só para exibição. Impacto na API: rotas `/empresas/:id/reservas/:rid` passam a receber string; `src/api.js` e `web/app.js` convertem `Number(rid)` hoje, e os testes de contrato (`tests/api.test.js`, régua `CHATFLOW_SERVIDOR`) e o Rust (`rust/one-store`) precisam acompanhar. Como é mudança de contrato, fazer **junto da entrada do banco**, não antes, e com os dois servidores (JS e Rust) na mesma versão. O histórico passa a guardar `entidade_id` como texto (já é: `String(e.entidadeId)`).

## 6. Próximos passos

1. Tratar os achados de [revisao-persistencia-t04](revisao-persistencia-t04.md) (esquema e repositório SQL).
2. `src/d1/repositorio.js` com a interface de `src/repositorio.js`. Já existe `src/sqlite/repositorio.js` (T04), que passa nos 56 testes com `CHATFLOW_BANCO=sqlite` mas usa transação interativa: serve de base e de teste de contrato, não é a versão D1.
3. Decisões da LGPD (seção 4) e da troca de id (seção 5).
4. Prova de concorrência de reserva no D1 local.
5. Cron de limpeza (`limparIdempotencia`) e, se aprovado, de anonimização por retenção.
