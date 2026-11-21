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

O backup automatizado cobre o **banco**, enquanto os bytes dos anexos ficam na pasta adjacente. Para um ponto de recuperação completo e consistente, pause as escritas e pare o serviço, execute o backup do banco e arquive `<arquivo-sqlite>.arquivos/` na mesma janela, junto com a referência da cópia e o checksum dos anexos. Retome o serviço depois que ambas as partes estiverem seguras. Se usar a opção de histórico externo em JSONL, arquive-o separadamente.

Restaure primeiro em um ambiente isolado. Com o serviço parado e o destino identificado por `CHATFLOW_BANCO_ARQUIVO`, use `node scripts/restaurar-sqlite.js "<pasta-da-copia>"`. O script valida a cópia, rejeita o banco em uso e guarda o arquivo anterior como `.antes-restauracao`. Preserve também a pasta atual de anexos e coloque a pasta correspondente ao ponto restaurado ao lado do banco. Confirme integridade, empresas, reservas e abertura de um anexo antes de liberar tráfego. Use `node --test tests/backup-sqlite.test.js` para exercitar os scripts em banco temporário.

O verificador local usa HTTP apenas em loopback com credenciais aleatórias efêmeras. A validação de TLS, redirecionamento, proxy, volume e recuperação no ambiente definitivo depende da futura publicação.
