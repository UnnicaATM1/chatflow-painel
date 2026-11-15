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
`KENDJI_WEB_DIR`. `KENDJI_FUSO` ainda não é lida (nenhuma regra usa "agora").

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
- Teste de carga só simbólico: 250 requisições paralelas (todas 200, 239 ms) e um corpo de 40 MB autenticado (413, e o servidor segue atendendo). Não há teste de longa duração nem de milhares de conexões.
- Diferenças de mensagem em corpo `null` e em `new URL()` com caminhos `..` não foram replicadas (casos que o JavaScript trata por acidente).
