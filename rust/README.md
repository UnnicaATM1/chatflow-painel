# ONE em Rust (fase 1: a API)

Port da API do ONE (`src/` em JavaScript) para Rust, com o **mesmo contrato HTTP**: rotas, status, JSON (inclusive a ordem
das chaves) e cabeçalhos iguais. O JavaScript continua sendo a referência e segue rodando; a versão Rust só substitui quando
a régua de contrato passar inteira (passou, ver abaixo). Plano e premissas: `docs/migracao-rust.md`.

## Estrutura

| Crate | O que é |
|---|---|
| `one-store` | Modelo de dados, trait `Plataforma` (relógio e aleatoriedade), trait `Repositorio` (assíncrono, com as operações atômicas nomeadas de `docs/atomicidade.md`) e a versão em memória (`Memoria`). D1 e R2 entram aqui. |
| `one-core` | Domínio e API: agentes, empresas, reservas, mapa, conhecimento (e busca), histórico, contexto, e `tratar(ctx, req) -> Resp`. Sem I/O, sem relógio nem aleatoriedade próprios, sem `tokio`. |
| `one-node` | Adaptador nativo (`axum` + `tokio`): rede, arquivos de `web/` (lista fechada), variáveis `KENDJI_*`, sumidouro de auditoria em arquivo, descarte de corpo não lido. É o único com I/O. |

Cada módulo de `one-core` espelha um arquivo de `src/` (`nucleo.rs` = `src/nucleo.js`, `reservas.rs` = `src/reservas.js`...).
O JavaScript é a especificação.

## Compilar e rodar

```
cd rust
cargo build --release
KENDJI_TOKEN_INTEGRACAO=... PORT=3000 ./target/release/one-node      # no Windows: target\release\one-node.exe
```

Mesmas variáveis do servidor em JavaScript: `PORT`, `KENDJI_TOKEN_CHAT`, `KENDJI_TOKEN_CLIENTE`, `KENDJI_TOKEN_INTEGRACAO`,
`KENDJI_ADMIN_SENHA`, `KENDJI_CORS_ORIGENS`, `KENDJI_CONFIAR_PROXY`, `KENDJI_DEMO`, `KENDJI_HISTORICO_ARQUIVO`,
`KENDJI_SEMENTE_ARQUIVO` (só testes). A pasta `web/` é achada a partir do diretório atual e dos pais do executável, ou por
`KENDJI_WEB_DIR`. `KENDJI_FUSO` (padrão `America/Sao_Paulo`) é lida e fica em `Config::fuso`; nenhuma regra usa "agora" ainda. Nome vazio ou com caracteres que um nome de fuso não tem volta ao padrão; como não há banco de fusos no núcleo, um nome bem formado mas inexistente passa (o JavaScript o trocaria pelo padrão). `KENDJI_LIMITE_CHAVE` e `KENDJI_LIMITE_INVALIDAS` mudam os limites de requisição por minuto (padrão 300 e 20).

## Verificar

```
cd rust && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test
```

**Régua de contrato HTTP** (a mesma bateria para JavaScript e Rust). Da raiz do projeto:

```
# JavaScript, em processo (padrão):                       npm test                                  -> 51 de 51
# JavaScript, como processo externo:
ONE_SERVIDOR='["node","src/server.js"]' node --test --test-force-exit tests/api.test.js      -> 34 de 34
# Rust:
ONE_SERVIDOR='["C:/caminho/rust/target/release/one-node.exe"]' node --test --test-force-exit tests/api.test.js  -> 34 de 34
```

`ONE_SERVIDOR` é um array JSON com o comando (sem shell, porque o caminho do projeto tem espaço). Cada teste sobe um processo
novo, semeia a empresa de teste com `KENDJI_SEMENTE_ARQUIVO` e fala só por HTTP. Dos 43 testes de `tests/api.test.js`, 34 são de
contrato e 9 são internos do JavaScript e ficam **pulados** nesse modo (núcleo chamado direto, repositório, plataformas,
varredura de `require`/`node:`, relógio injetado). O que cobre o mesmo terreno no Rust são os `cargo test` e o teste diferencial.

**Teste diferencial** (`node tests/diferencial-rust.js`): sobe o JavaScript e o Rust com a mesma semente, faz 109 requisições
(erros, bordas de validação, ordem das chaves, busca, documentos, exclusão, estáticos) e compara status, cabeçalhos relevantes e
corpo. Resultado: 0 diferenças. Com uma divergência plantada ele acusa.

## WebAssembly (prova de portabilidade)

`one-store` e `one-core` compilam para `wasm32-unknown-unknown` e **rodam**: o crate `one-wasm-prova` (cdylib) exporta
`prova()`, que monta o contexto com o repositório em memória e uma plataforma fixa e faz 15 verificações reais contra `tratar`
(criar empresa, ambiente, mesa, reserva às 23:30 que cruza a meia-noite, idempotência, conhecimento, busca, histórico, prompt).

```
rustup target add wasm32-unknown-unknown
cd rust && cargo build -p one-wasm-prova --target wasm32-unknown-unknown --release
cd .. && node tests/wasm-prova.js        # prova() = 0, módulo de ~840 KB, 0 importações do ambiente
```

O módulo não importa nada do ambiente (nenhum relógio, nenhuma rede): é a prova de que o núcleo não depende do sistema.
`one-node` (axum, tokio, getrandom) não é compilado para wasm; o adaptador Worker (`workers-rs`) fica para depois.
A mesma prova roda como `cargo test -p one-wasm-prova` no alvo nativo.

## Teste de carga

`node tests/carga.js` (Rust por padrão; `CARGA_COMANDO='["node","src/server.js"]'` para o JavaScript; `CARGA_SEGUNDOS`,
`CARGA_CONEX`, `CARGA_PARADAS`). Fase A: carga mista com escrita (40% leitura do agente, 20% disponibilidade, 20% POST de
reserva com chave única, 10% busca, 10% saúde). Fase B: milhares de conexões abertas ao mesmo tempo. Fase C: a mesma carga
depois, para ver se o servidor se recuperou. Os limites de requisição sobem por `KENDJI_LIMITE_CHAVE` e `KENDJI_LIMITE_INVALIDAS`.
O cliente é o próprio Node (teto de uns 13 mil req/s), então os números servem para comparar, não como capacidade máxima.

Resultados neste computador (Windows, cliente e servidor na mesma máquina, 64 conexões):

| | JavaScript (15 s) | Rust (15 s) | Rust (60 s, 5000 conexões) |
|---|---|---|---|
| carga mista | 8,4 mil req/s, p99 13,9 ms | 6,9 mil req/s, p99 24,3 ms | 7,9 mil req/s, p99 20,6 ms |
| conexões simultâneas | 2000 de 2000 | 2000 de 2000 | 5000 de 5000, 0 falhas |
| erros (status 0 ou 500) | 0 | 0 | 0 |
| depois das conexões | recuperou | recuperou (7,1 mil req/s) | recuperou (7,0 mil req/s) |

Por rota (4 s cada, 64 conexões): `/saude` JS 10,7 mil, Rust 12,9 mil; agente JS 9,5 mil, Rust 12,8 mil; disponibilidade JS 12,3 mil,
Rust 13,1 mil; busca no conhecimento JS 5,3 mil, Rust 8,2 mil; POST de reserva JS 8,2 mil, Rust 7,5 mil. Ou seja, o Rust empata ou
ganha por rota, exceto no POST de reserva (-9%); na carga mista o JavaScript ficou 17% à frente neste cliente.

**Achado: a memória cresce sem limite sob carga de escrita**, nos dois servidores. No Rust foram 6 MB parados, 61 MB depois de 60 s e
391 MB depois de 90 s com cerca de 685 mil requisições (~4 MB/s). A causa é o armazenamento de idempotência: cada POST de reserva
com chave nova guarda a resposta para sempre, inclusive a resposta "indisponivel", que é grande. O JavaScript mostrou o mesmo ritmo
(56 para 203 MB em 23 s). Em uso real (poucas reservas por minuto) leva meses para pesar, mas um cliente que gere uma chave nova a
cada tentativa consegue encher a memória. Correção sugerida: validade das chaves (por exemplo 24 h) ou teto de entradas por empresa.
Não mudei o comportamento porque é decisão de contrato.

## Decisões

- `serde_json` com `preserve_order` (a API devolve as chaves na ordem do JavaScript; `indexmap` entra por ele).
- Corpos de requisição como `serde_json::Value`, com as mesmas checagens e mensagens do JavaScript (`Number.isInteger`, `typeof`),
  em vez de structs tipadas, que mudariam status e mensagens de erro.
- Dependências: `serde_json`, `sha2` (SHA-256 das chaves), `base64` (documentos e chave gerada), `unicode-normalization` (a busca
  remove acentos como o `normalize('NFD')` do JavaScript), `getrandom` (chaves de API; aleatoriedade do sistema), `axum`, `tokio`
  e `http-body-util` (ler o corpo por quadros, sob demanda).
- Lints: `unsafe_code` proibido; `unwrap`/`expect` negados fora dos testes. O corpo só é lido depois de autenticar, com o limite
  da rota (512 KiB, ou 6 MiB no conhecimento); o que ninguém pediu é descartado sem ser guardado.

## Limites conhecidos

- Só o repositório em memória (como o JavaScript hoje). D1/R2, o adaptador Worker e o painel em Rust ficam para depois.
- Limite de requisições e bloqueio da senha do administrador seguem em memória por instância.
- Carga testada por 90 s e 5000 conexões simultâneas, não por horas; a memória sobe com as chaves de idempotência (ver acima).
- Compilei para Windows e para wasm32; não para Linux.
- Diferenças de mensagem em corpo `null` e em `new URL()` com caminhos `..` não foram replicadas (casos que o JavaScript trata por acidente).
