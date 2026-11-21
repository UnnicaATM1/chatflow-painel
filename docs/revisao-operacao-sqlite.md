# Revisão do endurecimento da operação do SQLite (TASK-014, T04)

Revisão feita em 2026-11-21 sobre `src/node/pid-sqlite.js`, `src/node/inicializar.js` (sinais), `src/sqlite/repositorio.js` (`fechar`, PRAGMAs) e `src/sqlite/migracoes.js`. Tudo medido com o servidor rodando como **processo filho** (`src/server.js`, `CHATFLOW_BANCO=sqlite`), não só lido. Testes: `tests/operacao-sqlite.test.js` (8 passam, 2 `todo` abertos) e sondas avulsas descritas abaixo. Resultado: `npm test` com 109 testes e 0 falhas em `CHATFLOW_BANCO=memoria` e em `sqlite` (107 passam, 2 `todo` são os achados O1 e O2).

Ambiente: Windows 11, Node 24.18. **Sem WSL nem Docker**: nada foi medido num Linux real (ver O5).

## 1. O que está certo (medido)

| Item | Medição |
|---|---|
| Duas instâncias no mesmo banco | A segunda sai com código 1 e a mensagem `O servidor SQLite parece estar rodando (PID n em "<banco>.pid")`; a primeira continua servindo e o `.pid` dela fica intacto; nenhum arquivo temporário sobra. |
| `.pid` velho depois de kill -9 | Reconhece o processo morto (`ESRCH`), assume e reescreve; as 5 empresas gravadas antes do kill estão lá (WAL recuperado na abertura). |
| `.pid` de outro processo vivo (reaproveitamento de pid) | Recusa e **não apaga** o arquivo do outro. `.pid` com pid inexistente é assumido. |
| Remoção só do que é seu | `liberar()` só apaga o arquivo se o conteúdo ainda for o próprio PID. |
| Corrida na subida | A leitura, a troca do `.pid` obsoleto e a criação (`wx`) ficam dentro de `BEGIN IMMEDIATE`, o que serializa duas subidas simultâneas. |
| SIGINT, SIGTERM e SIGBREAK (manipuladores) | Encerram com código 0 em cerca de 0,2 s, com `wal_checkpoint(TRUNCATE)`: `-wal` com 0 byte ou ausente, `-shm` ausente, `.pid` removido, todos os 30 registros no arquivo principal. |
| Conexão keep-alive ociosa | O desligamento não espera por ela (13 ms). |
| Falhas de subida | Arquivo que não é SQLite: sai com código 1, mensagem com o `integrity_check` e o aviso para a seção 5 de `docs/operacao-sqlite.md`, sem deixar `.pid`. Porta ocupada: sai com código 1 e remove o `.pid` da instância que falhou. |
| Backup e restauração com o `.pid` novo | Backup com o servidor ligado funciona; a restauração recusa enquanto o servidor roda (`parece estar rodando`), funciona depois do desligamento limpo e também com `.pid` velho de um kill -9. O formato do `.pid` (PID em texto, uma linha) é o que `scripts/restaurar-sqlite.js` lê. |
| PRAGMAs | `synchronous = FULL`, `wal_autocheckpoint = 1000` e `journal_size_limit = 64 MiB` são aplicados em toda abertura de arquivo. O `journal_size_limit` vale por conexão e só faz efeito quando o SQLite recicla o WAL; como o fechamento faz `TRUNCATE`, o `-wal` fica vazio mesmo assim. Verificado por leitura do código, não por medição (o limite de 64 MiB exigiria gerar um WAL desse tamanho). |

## 2. Achados

| # | Gravidade | Achado | Sugestão |
|---|---|---|---|
| O1 | **Alta** (contêiner) | `.pid` velho com o **PID do próprio processo** é tratado como "outro servidor vivo" (`process.kill(pid, 0)` devolve sucesso para si mesmo). O `Dockerfile` roda `node src/server.js` como **PID 1**: depois de uma queda sem desligamento limpo (OOM, `docker kill`, falta de energia) o `.pid` fica com `1`, o contêiner reinicia também com PID 1 e **recusa subir para sempre** (laço de reinício). Medido chamando `reservarPidSqlite` com `.pid` igual a `process.pid`: `RECUSOU`. A mesma classe de problema vale para qualquer PID baixo reaproveitado por outro processo do contêiner (um `sh`, o `tini`). | Tratar `pid === process.pid` como obsoleto. Opcional e mais forte: gravar também um identificador da instância (hostname ou `/proc/sys/kernel/random/boot_id`) e do início do processo, e só recusar se baterem; oferecer `CHATFLOW_IGNORAR_PID=1` documentado para emergência. Teste: `ACHADO O1 (todo)` em `tests/operacao-sqlite.test.js`. |
| O2 | **Alta** | **Sem prazo no desligamento.** `fechar()` espera `servidor.close()`, que só termina quando a última requisição em andamento acaba. Uma requisição pendurada (cliente lento ou parado) impede o fechamento: medido, o processo **não saiu em 30 s**, o `.pid` ficou e o `-wal` continuou com 470 KB. Um segundo SIGINT é ignorado (só SIGKILL resolve). Em hospedagem, o SIGKILL do orquestrador chega depois do prazo dele e o `-wal`/`.pid` ficam sujos (recuperável, mas é o que o desligamento limpo queria evitar). | Prazo (por exemplo 10 s, configurável): depois dele `servidor.closeAllConnections()` e seguir para `store.fechar()`; segundo sinal força a saída com código diferente de zero. Teste: `ACHADO O2 (todo)`. |
| O3 | Média | `.pid` aceita arquivo **vazio** como obsoleto e o apaga (medido: `arquivo .pid vazio: assumiu`). Hoje é seguro porque a criação com `wx` e a escrita acontecem dentro de `BEGIN IMMEDIATE`, mas o restaurador e qualquer outra leitura que não tenha esse bloqueio podem ver o arquivo recém-criado e ainda vazio. A escrita também não é atômica (cria e depois escreve). | Gravar em arquivo temporário e `rename` (atômico) ou aceitar a janela e documentá-la. O restaurador já trata conteúdo inválido como "sem servidor". |
| O4 | Média | **Windows**: SIGTERM não existe de verdade. `taskkill /F`, `Stop-Process` e parar um serviço terminam o processo à força, **sem** rodar nenhum manipulador (nem `exit`): `.pid` fica (assumido na próxima subida) e o `-wal` é recuperado. O que cobre: Ctrl+C (SIGINT), Ctrl+Break (SIGBREAK). **Não cobre**: fechar a janela do console (SIGHUP, sem manipulador) e logoff/desligamento do Windows. Não há `beforeExit` (e não ajudaria: ele não roda em saída forçada). | Documentar em `docs/operacao-sqlite.md` que em Windows o único desligamento limpo é Ctrl+C/Ctrl+Break (ou um serviço que os envie) e que o resto é queda tratada pela recuperação; registrar `SIGHUP` também. Em produção Linux (contêiner) nada disso se aplica. |
| O5 | Baixa | SIGTERM real (Linux) **não foi medido**: aqui os sinais foram emitidos dentro do processo filho (`tests/auxiliar/sinal-ipc.mjs`), o que exercita os mesmos manipuladores, mas não a entrega pelo sistema nem o comportamento do `docker stop` (SIGTERM, 10 s, SIGKILL). | Rodar `tests/operacao-sqlite.test.js` num Linux (CI ou contêiner); nele o teste usa `child.kill(sinal)` de verdade. |
| O6 | Baixa | O erro `parece estar rodando` não diz o que fazer quando o PID é de outro processo por reaproveitamento (no Windows isso é comum). | Acrescentar à mensagem: "se tem certeza de que não há outro servidor, apague `<arquivo>.pid`". |
| O7 | Baixa | Queda por exceção não tratada ou `process.exit`: o gancho de `exit` remove o `.pid`, mas **sem** checkpoint do WAL (recuperado na próxima abertura; seguro). | Aceitável; mencionar na documentação. |

## 3. Medição de carga com os ids novos (item 4)

**O T04 não citou nenhuma medição de carga com os ids novos** (nem no HANDOFF nem em `docs/operacao-sqlite.md`; o último número de carga registrado é o da TASK-009, com ids sequenciais e servidor em memória). Medi agora.

`tests/carga.js` **não repassa** `CHATFLOW_BANCO` nem `CHATFLOW_BANCO_ARQUIVO` ao servidor (o ambiente do filho é montado à mão e só inclui `CHATFLOW_IDEMPOTENCIA_*`): com `CARGA_COMANDO='["node","src/server.js"]'` o servidor sobe **em memória**, e qualquer "carga com SQLite" feita assim mede a memória sem avisar. Usei um embrulho em arquivo temporário (fora do repositório) que define as duas variáveis e importa `src/server.js`, e confirmei que ele criou o arquivo `.sqlite`. Parâmetros: `CARGA_SEGUNDOS=15 CARGA_PARADAS=500`, 64 conexões, carga mista (40% leitura do agente, 20% disponibilidade, 20% POST de reserva, 10% busca, 10% saúde).

| Servidor | Execução | Fase A (rps) | p50 / p95 / p99 (ms) | Fase C (rps) | Memória final | Erros |
|---|---|---|---|---|---|---|
| SQLite | 1 | 856 | 69,5 / 109,3 / 340,8 | 771 | 228 MB | 0 |
| SQLite | 2 | 842 | 71,1 / 109,7 / 349,2 | 760 | 222 MB | 0 |
| SQLite | 3 | 859 | 70,4 / 99,0 / 336,0 | 752 | 229 MB | 0 |
| Memória | 1 | 10045 | 5,4 / 7,9 / 11,1 | 10223 | 207 MB | 0 |
| Memória | 2 | 10104 | 5,4 / 7,6 / 11,1 | 10146 | 208 MB | 0 |

**Reprodutível**: no SQLite a vazão varia de 842 a 859 rps (cerca de 2%) e a memória de 222 a 229 MB; na memória, de 10045 a 10104. Todas as execuções terminaram sem status 0 ou 500, as 500 conexões simultâneas responderam e o servidor seguiu vivo. As reservas na empresa 1 ficam em 224 nos dois modos (o limite é o número de mesas e horários da carga, não o banco).

**Leitura dos números**: o SQLite é cerca de **12 vezes mais lento** que a memória nesta carga (a maior parte é leitura do agente e da disponibilidade, que hoje vão ao banco a cada requisição). Para o uso real (restaurante, centenas de reservas por dia) 850 rps sobra com folga, mas o teto é de um processo só. A latência p99 de 340 ms vem de enfileirar a escrita. A memória do SQLite cresce de 63 para 228 MB e estabiliza (fase C estável), em linha com o modo memória (207 MB).

| # | Gravidade | Achado | Sugestão |
|---|---|---|---|
| O8 | Média | `tests/carga.js` não repassa `CHATFLOW_BANCO*`: a medição "com SQLite" é impossível sem embrulho e engana quem usa só `CARGA_COMANDO`. (É um arquivo compartilhado, não editei.) | Repassar `CHATFLOW_BANCO` e `CHATFLOW_BANCO_ARQUIVO` (arquivo temporário novo por execução) e registrar o resultado SQLite em `docs/operacao-sqlite.md` ou no HANDOFF, com os parâmetros usados. |
| O9 | Baixa | A carga mede um arquivo recém-criado e pequeno; nada diz como se comporta com banco grande (anexos, histórico de meses). | Repetir com um banco semeado com dezenas de milhares de reservas e eventos antes de dar o número como definitivo. |

## 4. Resultado

- **Aprovado**: `.pid` (duas instâncias, velho, de outro processo, inexistente), desligamento limpo por SIGINT/SIGTERM/SIGBREAK com checkpoint, backup e restauração com o `.pid` novo, PRAGMAs e mensagens de falha de subida.
- **Corrigir antes do deploy em contêiner**: **O1** (laço de reinício depois de queda com PID 1) e **O2** (desligamento sem prazo). Os dois têm teste `todo` pronto; ao corrigir, tirar o `todo`.
- **Documentar**: O4 (Windows), O5 (falta de medição em Linux), O6, O7, O8 e O9.
- Os 8 testes de `tests/operacao-sqlite.test.js` passam; os `todo` O1 e O2 documentam o que falta.
