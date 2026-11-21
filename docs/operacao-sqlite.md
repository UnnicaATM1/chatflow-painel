# Operação do ChatFlow Painel com SQLite em disco

Para quem coloca o servidor Node no ar com `CHATFLOW_BANCO=sqlite`. Complementa [persistencia](persistencia.md) (como os dados são guardados). Os scripts ficam em `scripts/` e não precisam de dependências além do Node 22 ou mais novo (testado no Node 24).

## 1. Configuração de produção

| Variável | Para quê | Padrão |
|---|---|---|
| `CHATFLOW_BANCO` | `sqlite` liga o banco; `memoria` perde tudo ao reiniciar | `memoria` |
| `CHATFLOW_BANCO_ARQUIVO` | caminho do arquivo do banco, **em disco persistente** | `chatflow.sqlite` (relativo ao diretório de onde o Node foi iniciado: use caminho absoluto) |
| `CHATFLOW_BACKUP_DIR` | pasta das cópias, **de preferência em outro disco ou volume** | `./backups` |
| `CHATFLOW_BACKUP_MANTER` | quantas cópias guardar | `14` |
| `CHATFLOW_IDEMPOTENCIA_HORAS`, `CHATFLOW_IDEMPOTENCIA_MAX` | validade e teto das respostas de idempotência | 24 e 10000 |

Regras que não têm exceção:

1. **Um único processo escritor.** O SQLite aceita vários leitores, mas o servidor guarda estado em memória (limite de requisições, bloqueio de senha) e serializa as gravações por processo. Duas instâncias do ONE no mesmo arquivo podem funcionar, mas perdem essas garantias. Hospedagem com mais de uma instância (escala horizontal, deploy com sobreposição entre a versão nova e a velha) exige parar a antiga antes de subir a nova.
2. **Disco local e persistente.** O arquivo precisa estar em volume que sobrevive a reinício e a novo deploy. **Não** use pasta de rede (NFS, SMB, armazenamento de objetos montado): o bloqueio de arquivo do SQLite e o modo WAL não são confiáveis nelas e o banco pode corromper.
3. **O arquivo do banco nunca fica dentro da pasta que o deploy apaga e recria** (pasta do código, `dist`, diretório temporário do contêiner).
4. **Permissão**: só o usuário do processo lê e grava o arquivo, o `-wal`, o `-shm` e a pasta de backups (por exemplo `chmod 600` e a pasta com `chmod 700`). Eles guardam dado pessoal (seção 6).

### WAL e os arquivos ao lado do banco

O servidor liga `journal_mode = WAL`. Com o banco aberto aparecem, **na mesma pasta**:

- `chatflow.sqlite-wal`: gravações ainda não incorporadas ao arquivo principal;
- `chatflow.sqlite-shm`: índice em memória compartilhada do WAL.

Os três formam uma unidade. **Nunca copie só `chatflow.sqlite` com o servidor ligado**: o que está no `-wal` fica de fora e a cópia pode estar desatualizada ou inconsistente. Nunca apague `-wal` ou `-shm` à mão com o servidor ligado, nem depois de uma queda (o SQLite os usa para se recuperar). Ao fechar normalmente o servidor, o SQLite incorpora o WAL e remove os dois.

**O que copiar no backup:** nada diretamente. Use `scripts/backup-sqlite.js`, que pede ao próprio SQLite uma cópia consistente (seção 2). Se for inevitável copiar arquivos (servidor **parado**), copie o `.sqlite`, se existirem `-wal` e `-shm`, **e a pasta `chatflow.sqlite.arquivos/`** (anexos do conhecimento) juntos.

### Anexos do conhecimento: `<banco>.arquivos/`

Os documentos do conhecimento (PDF, Word, Excel, texto) **não ficam dentro do banco**: cada um é um arquivo em `chatflow.sqlite.arquivos/<uuid>`, e a linha de `conhecimento` guarda os metadados e o `arquivoChave`. O banco e a pasta formam **um conjunto só**: banco sem a pasta restaurado deixa itens apontando para arquivo inexistente (o download falha); pasta sem o banco são arquivos soltos. A pasta fica ao lado do banco, no mesmo disco persistente e com a mesma permissão restrita (700), e entra no mesmo backup. Os anexos nunca são alterados no lugar (cada versão ganha um uuid novo e o antigo é apagado depois do `COMMIT`), o que torna a cópia simples de fazer de forma consistente.

## 2. Backup

```
node scripts/backup-sqlite.js
```

O que faz: abre o banco (mesmo em uso), usa a API de backup do `node:sqlite` (se a versão do Node não tiver, usa `VACUUM INTO`), grava em `CHATFLOW_BACKUP_DIR/<data UTC>/chatflow.sqlite` e, depois do snapshot do banco, copia `<banco>.arquivos/` para `CHATFLOW_BACKUP_DIR/<data UTC>/arquivos/`, tira o modo WAL da **cópia** (para não gerar `-wal`/`-shm` ao lado dela), confere na cópia `PRAGMA integrity_check` e `PRAGMA foreign_key_check`, **confere que todo anexo referenciado pelas linhas do conhecimento existe na cópia** (se o servidor apagou um no meio da cópia, refaz até 3 vezes; se continuar faltando, o backup falha, pois o banco aponta para arquivo perdido), **avisa sobre anexos órfãos** (arquivo sem linha no banco: sobra de uma gravação interrompida ou de limpeza pendente; é copiado mesmo assim e não impede o backup), grava `chatflow.sqlite.sha256` e só então renomeia a pasta de `.parcial` para o carimbo e apaga as cópias além das `CHATFLOW_BACKUP_MANTER` mais novas. Se qualquer verificação falhar, o script sai com código 1, remove a cópia incompleta e **não apaga nenhuma cópia antiga**. Só pastas com nome de carimbo são apagadas; qualquer outra coisa na pasta de backups fica intacta.

### Agenda

- **Diária**, em horário de pouco uso (por exemplo 03:30), pelo agendador do servidor (`cron`, tarefa agendada, agendador da hospedagem): `30 3 * * * cd /app && node scripts/backup-sqlite.js >> /var/log/chatflow-backup.log 2>&1`.
- Com 14 cópias diárias você tem duas semanas de histórico. Se a perda tolerável for menor que um dia, rode de hora em hora e aumente `CHATFLOW_BACKUP_MANTER` (cada cópia tem o tamanho do banco; o conhecimento com arquivos de até 4 MB pesa).
- **Alarme**: o código de saída diferente de zero precisa chegar a uma pessoa. Além disso, alerte se a cópia mais nova tiver mais de 26 horas.
- **Fora do servidor**: a pasta de backups no mesmo disco não protege contra perda do disco. Envie a cópia mais nova para outro lugar (outro volume, armazenamento de objetos), **criptografada** (seção 6).
- Antes de qualquer mudança arriscada (migração nova, atualização grande): rode o backup à mão e confira a saída.

## 3. Teste de restauração

Backup que nunca foi restaurado não é backup. **Uma vez por mês**, e depois de mudar o esquema:

1. Em outra pasta (ou máquina), sem tocar no banco de produção: `CHATFLOW_BANCO_ARQUIVO=/tmp/teste.sqlite node scripts/restaurar-sqlite.js backups/<cópia mais nova>`.
2. Suba um servidor de teste apontando para esse arquivo (`CHATFLOW_BANCO=sqlite CHATFLOW_BANCO_ARQUIVO=/tmp/teste.sqlite PORT=3911 node src/server.js`) e confira: empresas, reservas do dia, histórico e uma leitura da base de conhecimento.
3. Anote data, cópia usada e quanto tempo levou. Apague o arquivo de teste (ele tem dado pessoal).

## 4. Restaurar (produção)

```
# 1. PARE o servidor.
# 2. (opcional, recomendado) backup do estado atual:  node scripts/backup-sqlite.js
# 3.
node scripts/restaurar-sqlite.js backups/2026-11-21T03-30-00-000Z
# 4. Suba o servidor e confira.
```

O script: valida a cópia **antes** (integridade, chaves estrangeiras, tabelas do ChatFlow; cópia inválida é recusada sem tocar em nada), recusa rodar se o banco estiver em uso (bloqueio do SQLite, ou arquivo `<banco>.pid` com processo vivo), guarda o arquivo atual como `chatflow.sqlite.antes-restauracao` (e `-wal`/`-shm` antigos junto, para não serem aplicados sobre o arquivo restaurado; se já existir um guardado, grava com carimbo no nome, nunca sobrescreve) e troca o arquivo por renomeação. Os **anexos** voltam junto: o script confere que todo anexo referenciado pelo banco da cópia existe em `arquivos/` (se faltar, a cópia é recusada sem tocar em nada), prepara a pasta nova ao lado, guarda a `chatflow.sqlite.arquivos/` atual como `chatflow.sqlite.arquivos.antes-restauracao` e põe a restaurada no lugar; se a troca da pasta falhar, o banco antigo volta ao lugar. O sinal de "servidor aberto" é a tentativa de obter o bloqueio exclusivo do banco (`BEGIN IMMEDIATE` em modo exclusivo, sem espera) e o `.pid`, **não** a existência de `-wal`/`-shm`: com WAL esses dois arquivos podem sobrar ao lado do banco depois de fechado, e isso não impede a restauração (eles saem de perto, junto com o arquivo antigo). Perde-se o que foi gravado **depois** da cópia; o `.antes-restauracao` guarda esse trecho caso seja preciso recuperar à mão.

Limitação: se o servidor estiver ligado mas ocioso e o banco **não** estiver em WAL, o SQLite não tem como acusar o uso. Por isso a regra é sempre parar o servidor primeiro; o `.pid` e o WAL são redes de segurança, não substitutos.

## 5. Recuperação passo a passo de arquivo corrompido

Sinais: o servidor se recusa a subir citando `integrity_check`, erros `database disk image is malformed`, `not a database`, ou consultas que falham sem motivo.

1. **Pare o servidor** e não tente "consertar" com ele ligado.
2. **Preserve a evidência**: copie, para outra pasta, o `.sqlite` e também `-wal` e `-shm` (se existirem). Não apague nada.
3. **Veja se o problema é só o `-wal`**: com o servidor parado, abra o banco uma vez (por exemplo `node -e "new (require('node:sqlite').DatabaseSync)(process.argv[1]).close()" /caminho/chatflow.sqlite`): o SQLite aplica o WAL pendente sozinho. Depois suba o servidor: ele confere o `integrity_check` na subida e recusa iniciar se falhar.
4. **Se ainda corrompido, restaure a última cópia boa**: `node scripts/restaurar-sqlite.js backups/<cópia mais nova>`. Se a mais nova falhar na validação, o script diz o motivo; tente a anterior.
5. **Recuperar o que veio depois da cópia** (opcional): o `.antes-restauracao` (ou a evidência do passo 2) pode ter linhas legíveis. Com o `sqlite3`: `sqlite3 antes-restauracao ".recover" | sqlite3 recuperado.sqlite`, depois valide `recuperado.sqlite` com o mesmo critério (integridade e chaves estrangeiras) e extraia só o que falta, por script, sem substituir o banco restaurado. **Não** coloque dado recuperado no banco sem conferir: o histórico é só de acréscimo e linhas órfãs viram erro.
6. **Confira os anexos**: depois da restauração, baixe um documento do conhecimento no painel (ou rode o backup de novo: ele falha se algum anexo referenciado não existir). **Suba o servidor**, confira (empresas, reservas de hoje, histórico) e avise quem usa que existe uma janela de dados perdidos (da hora da cópia até a queda).
7. **Causa**: descubra antes de seguir. Disco cheio, pasta de rede, dois processos no mesmo arquivo, `kill -9` durante gravação com `synchronous` baixo, ou cópia manual do `.sqlite` sem o `-wal` são as causas comuns.
8. Registre o incidente (data, causa, cópia usada, dados perdidos). Se havia dado pessoal em evidência copiada no passo 2, aplique a retenção da seção 6 a ela também.

## 6. LGPD e o backup

O banco guarda **nome e contato de clientes** das reservas (`nome_cliente`, `contato`) e o histórico pode ter cópia desses dados (ver [persistencia](persistencia.md), seção 4, e a decisão ainda pendente sobre o histórico). Cada cópia de backup é, portanto, **mais uma base com dado pessoal**.

- **Retenção da cópia**: a regra de retenção das reservas (proposta: anonimizar 90 dias depois da data da reserva) só vale de verdade quando a **última cópia com o dado antigo** expirar. Com 14 cópias diárias, a anonimização aparece em todas as cópias em 14 dias; com cópias mensais guardadas por um ano, o dado fica um ano. Escolha `CHATFLOW_BACKUP_MANTER` e a frequência de acordo com o prazo que o João aprovar, e **não guarde cópias "para sempre"**.
- **Pedido de apagamento do titular**: o dado some das cópias existentes só quando elas expiram. Comunicar isso ao titular (a base legal permite manter backup por prazo curto e documentado) e **nunca restaurar uma cópia antiga sem reaplicar os apagamentos e anonimizações feitos depois dela**. Mantenha um registro dos pedidos de apagamento (sem o dado apagado) para reaplicar após uma restauração.
- **Criptografia em repouso**: o arquivo do SQLite **não é criptografado**. Proteja: (a) disco do servidor criptografado pela hospedagem (volume cifrado); (b) cópias que saem do servidor cifradas antes de enviar (por exemplo `age` ou `gpg` com chave que não fica no mesmo servidor); (c) chave de criptografia guardada separada das cópias. Sem criptografia nenhuma, trate a pasta de backups com o mesmo cuidado de um banco de clientes.
- **Acesso**: permissões do item 4 da seção 1; lista curta de quem pode ler os backups; sem cópias em e-mail, chat ou pasta compartilhada.
- **Ambientes de teste**: não restaure produção em máquina de desenvolvimento sem necessidade; se restaurar (teste mensal), apague depois.
- **Anexos**: os documentos do conhecimento podem conter dado pessoal (tabelas de preço costumam não ter, mas contratos e listas de clientes têm). A pasta `arquivos/` de cada cópia tem a mesma retenção, a mesma cifragem e as mesmas permissões do banco.
- **Apagar a cópia**: `rm` comum basta se o disco é cifrado; sem cifra, trate a remoção como parcial (o dado pode permanecer no disco), mais um motivo para cifrar.
- **Logs**: o script imprime só caminhos e tamanhos, nunca conteúdo.

## 7. O que pedir ao T04 (repositório SQLite)

Situação em 2026-11-21, conferida em `src/sqlite/repositorio.js`:

| Item | Estado |
|---|---|
| `PRAGMA journal_mode = WAL` (recusa se não conseguir) | Já feito |
| `PRAGMA synchronous = FULL` | Já feito. Justificativa: com WAL, `NORMAL` pode perder as últimas transações confirmadas numa queda de energia (sem corromper); como cada reserva e cada evento de histórico é um dado de negócio e o volume é baixo, `FULL` custa pouco e evita perder reserva confirmada ao cliente. Só reduzir para `NORMAL` se medir gargalo. |
| `PRAGMA busy_timeout` | Já feito (5000 ms) |
| `PRAGMA foreign_keys = ON` | Já feito |
| `integrity_check` na subida, com recusa de iniciar se falhar | Já feito (conferir que o erro sobe até `inicializar.js` e o processo termina com código diferente de zero, sem criar banco novo vazio por cima) |

**Ainda a pedir:**

1. **Arquivo de PID**: ao abrir um banco em arquivo, gravar `<banco>.pid` com `process.pid` e removê-lo em `fechar()` e na saída do processo; se na subida o `.pid` apontar para um processo vivo, **recusar iniciar** (impede o segundo escritor). O restaurador já lê esse arquivo.
2. **Encerramento limpo**: tratar `SIGTERM` e `SIGINT` chamando `repositorio.fechar()`, para que o WAL seja incorporado e `-wal`/`-shm` removidos; hospedagens mandam `SIGTERM` em todo deploy.
3. **`PRAGMA wal_autocheckpoint`** (o padrão de 1000 páginas serve) e **`PRAGMA journal_size_limit`** (por exemplo 64 MB) para o `-wal` não crescer sem limite se houver um leitor longo.
4. **Falha de verificação com mensagem acionável**: o texto do erro de `integrity_check` deve apontar para `docs/operacao-sqlite.md`, seção 5.
5. **Rotina de manutenção**: chamar `limparIdempotencia` (já existe) periodicamente e, se aprovada a LGPD, a anonimização por retenção; o backup diário não resolve isso.
6. **`PRAGMA optimize`** ao fechar (barato, mantém as estatísticas dos índices).
7. **Migrações**: o achado R2 de [revisao-persistencia-t04](revisao-persistencia-t04.md) (aplicar `0002` em diante) precisa estar resolvido **antes** do primeiro deploy com dados reais, e todo deploy com migração nova deve ser precedido de backup.

## 8. Lista de verificação do primeiro deploy

- [ ] `CHATFLOW_BANCO=sqlite` e `CHATFLOW_BANCO_ARQUIVO` com caminho absoluto em volume persistente local.
- [ ] Um único processo; permissões 600/700.
- [ ] Backup diário agendado, alarme de falha e envio cifrado para fora do servidor.
- [ ] Teste de restauração feito uma vez **antes** de ir ao ar, com o tempo anotado.
- [ ] Sem `CHATFLOW_TOKEN_CHAT` global (ver HANDOFF) e `CHATFLOW_ADMIN_SENHA` forte.
- [ ] Prazos de retenção e política de privacidade decididos (seção 6).
