# Preparação de produção do ChatFlow Painel

A publicação depende do fechamento das **TASK-010 e TASK-012** e da confirmação do ambiente de hospedagem. Use a API JavaScript em Node. A versão Rust só tem repositório em memória e fica fora desta publicação.

## Runtime e configuração

Use **Node 22.13.0 ou superior**. Essa versão disponibiliza `node:sqlite` sem a flag experimental na série 22. A série 23 passou a dispensar a flag a partir da versão 23.4.0. O campo `engines.node` exclui esse intervalo da série 23. Em produção, recomenda-se uma versão LTS atualizada. [Histórico oficial de node:sqlite](https://nodejs.org/api/sqlite.html#sqlite).

Configure **exatamente uma instância** do processo, sem cluster nem sobreposição entre a instância antiga e a nova durante reinícios. SQLite admite um escritor por vez. O rate limit vive em memória por instância e reinicia com o processo. Na revisão atual, o bloqueio administrativo usa o repositório: fica em memória nesse modo e persiste em `tentativas_admin` no SQLite. A exigência de instância única permanece.

| Variável | Configuração de produção |
|---|---|
| `PORT` | Porta interna usada pelo proxy para alcançar o Node. |
| `CHATFLOW_BANCO` | Obrigatória, com valor explícito `sqlite`. O padrão é memória, que perde os dados ao reiniciar. |
| `CHATFLOW_BANCO_ARQUIVO` | Obrigatória, com caminho absoluto em volume persistente gravável, por exemplo `/dados/chatflow/chatflow.sqlite`. |
| `CHATFLOW_TOKEN_CLIENTE`, `CHATFLOW_TOKEN_INTEGRACAO`, `CHATFLOW_ADMIN_SENHA` | Três valores inéditos e independentes, configurados no gerenciador de segredos. |
| `CHATFLOW_CORS_ORIGENS` | Origens HTTPS exatas separadas por vírgula, sem caminho. Pode ficar ausente quando painel e API usam a mesma origem. |
| `CHATFLOW_CONFIAR_PROXY` | Defina `1` somente atrás do proxy confiável descrito abaixo. |

**Mantenha ausentes** `CHATFLOW_TOKEN_CHAT`, `CHATFLOW_DEMO` e `CHATFLOW_SEMENTE_ARQUIVO`. No momento da publicação, gere três segredos com o gerador criptográfico de um gerenciador de senhas, com pelo menos 32 bytes aleatórios independentes por valor. Transfira-os diretamente para os segredos do ambiente. Guarde a cópia de recuperação no cofre autorizado fora do repositório. Evite que valores apareçam em argumentos de linha de comando, logs, arquivos versionados ou mensagens.

Monte o volume antes de iniciar. Garanta acesso de leitura e escrita do usuário do serviço à pasta do banco, aos auxiliares WAL/SHM e a `<arquivo-sqlite>.arquivos/`, onde ficam os documentos. Restrinja acesso ao volume e aos backups. O diretório de trabalho da aplicação pode ser substituído na atualização, mas o volume e seu caminho precisam permanecer.

## HTTPS, inicialização e reinício

1. Configure TLS no proxy, com redirecionamento permanente de HTTP para HTTPS. Confine a porta do Node à rede interna ou ao host e bloqueie acesso direto externo. O proxy de confiança deve normalizar `X-Forwarded-For` e garantir que seu último valor represente o IP do cliente observado por ele. O código usa esse último valor quando a confiança está habilitada.
2. Antes da primeira publicação, confirme TASK-010 e TASK-012 fechadas, rode `npm test` e `node tests/verificar-producao.js`. Preserve qualquer migração de `db/migrations/` já aplicada em produção. Evoluções de esquema precisam de novo arquivo e validação de atualização a partir de uma cópia.
3. Com volume montado e ambiente configurado, configure o supervisor do ambiente para executar `npm start` na raiz da versão aprovada. Verifique HTTPS em `/saude` e `/app/` e confira o redirecionamento HTTP sem enviar chaves. Verifique CORS, ausência de autenticação em `/saude` e a exigência de token em `/empresas`.
4. Para reiniciar, retire temporariamente o tráfego, pare a instância pelo supervisor e aguarde o processo encerrar. Inicie uma única instância com o mesmo volume, configuração e segredos. Confirme saúde e a leitura de um registro conhecido antes de voltar a encaminhar tráfego. Um banco novo e vazio é esperado só no primeiro início intencional, com o volume correto.

## Backup e restauração

Faça backups periódicos e antes de mudanças de versão. Exporte `CHATFLOW_BANCO_ARQUIVO` com o caminho do banco, `CHATFLOW_BACKUP_DIR` com um destino protegido fora do volume principal e, se necessário, `CHATFLOW_BACKUP_MANTER` para ajustar a retenção local (padrão de 14 cópias). Use `node scripts/backup-sqlite.js`. O script copia o banco em uso por API SQLite ou por `VACUUM INTO`, valida integridade e chaves estrangeiras, grava checksum e depois roda a retenção. Guarde uma cópia independente da rotação local. Não faça cópia simples do arquivo SQLite ativo em WAL.

O script também copia os anexos de `<arquivo-sqlite>.arquivos/` para a subpasta `arquivos/` do backup e confere se todos os anexos referenciados estão presentes. Para a cópia antes de uma atualização ou migração, pause as escritas até a conclusão. Guarde a pasta inteira da cópia, incluindo o checksum do banco. Se usar o histórico externo em JSONL, arquive-o separadamente.

Restaure primeiro em um ambiente isolado. Com o serviço parado e o destino identificado por `CHATFLOW_BANCO_ARQUIVO`, use `node scripts/restaurar-sqlite.js "<pasta-da-copia>"`. O script valida o banco e a presença dos anexos da cópia, rejeita o banco em uso e guarda o banco e a pasta de anexos anteriores com o sufixo `.antes-restauracao`. Confirme integridade, empresas, reservas e abertura de um anexo antes de liberar tráfego. Use `node --test tests/backup-sqlite.test.js` para exercitar os scripts em banco temporário.

O verificador local usa HTTP apenas em loopback com credenciais aleatórias efêmeras. A validação de TLS, redirecionamento, proxy, volume e recuperação no ambiente definitivo depende da futura publicação.

## Contêiner e hospedagem

Após o fechamento de **TASK-010 e TASK-012**, use o [Dockerfile](../Dockerfile) como opção de empacotamento. A imagem roda Node 24 como usuário `node` e verifica `/saude` com o próprio Node. O contêiner atende HTTP na porta interna configurada por `PORT` ou na 3000. O proxy do provedor termina o TLS. Antes de iniciar, confirme no ambiente que o volume montado permite escrita ao usuário `node`. Um volume pode substituir as permissões do diretório criado na imagem.

O exemplo define um serviço Docker com uma instância, disco de 1 GiB em `/var/data`, verificação em `/saude` e deploy automático desativado. O Blueprint fixa `CHATFLOW_BANCO=sqlite`, `CHATFLOW_BANCO_ARQUIVO=/var/data/chatflow.sqlite` e `CHATFLOW_CONFIAR_PROXY=1`. Os tokens, a senha e a origem CORS aparecem só pelo nome com `sync: false`. Preencha-os no Render. Antes de liberar tráfego, confirme que apenas o proxy alcança a porta do Node e que o último valor de `X-Forwarded-For` representa o cliente observado na entrada. Revise o plano e o tamanho do volume antes de aplicar o exemplo. [Exemplo de Blueprint](../render.yaml) · [Referência do Render](https://render.com/docs/blueprint-spec) · [Discos persistentes](https://render.com/docs/disks).

- **Railway**. Use o Dockerfile, configure uma réplica, anexe um volume em `/var/data` e configure `/saude` como healthcheck. Preencha as variáveis no serviço e valide HTTPS e o encaminhamento do IP no domínio usado. [Volumes no Railway](https://docs.railway.com/volumes).
- **Fly.io**. Use o Dockerfile com uma Machine e um volume na mesma região. Monte o volume em `/var/data`, alinhe `internal_port` com `PORT`, configure o healthcheck HTTP em `/saude` e habilite `force_https`. Preencha a configuração e os segredos na plataforma. [Configuração do Fly.io](https://fly.io/docs/reference/configuration/).

O Dockerfile inclui os dois scripts e seu módulo auxiliar. Os três arquivos, mantidos pela TASK-010, precisam estar versionados na revisão usada para construir a imagem. Para backup, execute `node scripts/backup-sqlite.js` a partir de `/app` no shell do serviço que tem acesso ao disco. Se o volume for o único destino gravável, use uma pasta privada nele para a cópia temporária e transfira a pasta inteira para armazenamento protegido fora do volume. Para restauração, use a mesma imagem em modo de manutenção, com acesso exclusivo ao volume e sem iniciar a API. Confirme com o provedor como abrir esse ambiente antes da primeira publicação.

## Painel no Sites

O painel em `/sites` depende de uma API publicada em HTTPS. Depois de validar a API, configure `CHATFLOW_CORS_ORIGENS` com a origem HTTPS exata do painel publicado, sem caminho nem barra final, por exemplo `https://painel.exemplo.com`. Confirme que a API envia o cabeçalho CORS para essa origem e omite o cabeçalho para uma origem diferente.

O T00 ajusta `window.CHATFLOW_CONFIG.apiBase` em `web/config.js` quando a URL da API estiver disponível. Use a origem HTTPS da API sem barra final, como `https://api.exemplo.com`. A configuração fica no arquivo público do painel e deve conter apenas o endereço. Depois de publicar os assets, confirme login e leitura da lista de empresas a partir do painel hospedado.
