# Migração do ONE para Rust

Decisão do João: o código do ONE deve ser todo em Rust. Hoje é JavaScript (Node na API, React no painel). O João fechou a pergunta de escopo sem responder; este plano usa as premissas abaixo, que são as mais seguras e reversíveis. **Premissas, para o João corrigir se discordar:**

1. **Fase 1 (agora): a API em Rust.** O painel continua em JavaScript até a fase 2.
2. **Fase 2 (depois de confirmar): o painel em Rust** (WebAssembly com Leptos ou Dioxus). Muda o design system (hoje React); só começa com o OK do João.
3. **O JavaScript atual não é tocado e continua rodando** o teste com o NicoChat. A versão Rust só substitui quando passar em todos os testes de contrato.
4. **O destino final pode ser o Worker do Sites** (Rust compila para WebAssembly via `workers-rs`). Por isso a arquitetura repete a da TASK-005: núcleo puro, adaptadores finos.

## Arquitetura (pasta `rust/`, workspace Cargo)

| Crate | O que é | Regra |
|---|---|---|
| `one-core` | Domínio e API: agentes, empresas, reservas, conhecimento, histórico, contexto, busca, `tratar(req) -> resp` | Sem I/O, sem relógio nem aleatoriedade próprios: tudo vem do trait `Plataforma`. Compila para `wasm32`. Sem `tokio` nem `std::fs` |
| `one-store` | Trait `Repositorio` (assíncrono, com as operações atômicas nomeadas) e a versão em memória | D1 e R2 entram aqui depois |
| `one-node` | Adaptador nativo: `axum` + `tokio`, arquivos estáticos de `web/`, variáveis de ambiente, sumidouro de auditoria em arquivo | É o único com I/O |
| `one-worker` (futuro) | Adaptador `workers-rs` | Fora do escopo agora |

Referência de comportamento: o JavaScript de `src/` (núcleo em `src/nucleo.js`, repositório em `src/repositorio.js`) e `docs/atomicidade.md`, `docs/portabilidade-worker.md`.

## A régua: testes de contrato HTTP

Os 51 testes atuais (`tests/`) testam a API por HTTP. Torne-os independentes da implementação: o teste sobe um servidor por **comando configurável** (`CHATFLOW_SERVIDOR=...`), em vez de importar o JS. Rodam contra o JavaScript hoje e contra o binário Rust amanhã, com os mesmos resultados. A versão Rust só substitui quando passar em todos. Não mude o contrato HTTP: rotas, status, JSON e cabeçalhos iguais.

## Fases da API

1. Esqueleto: workspace, `Plataforma`, tipos, erros, `/saude`, autenticação por chave (hash SHA-256), rate limit, CORS.
2. Empresas, módulos, agente (5 campos e limites), ambientes e mesas.
3. Reservas: disponibilidade, criar com idempotência, editar, cancelar, reativar, datas em minutos absolutos sem fuso.
4. Histórico e desfazer; exclusão de empresa com senha e bloqueio por tentativas.
5. Conhecimento: texto, tabela, documento (validação por bytes), busca, contexto e prompt.
6. Adaptador `axum`, arquivos estáticos de `web/`, `config.js`, redirect de `/app` para `/app/`.
7. Paridade: todos os testes de contrato verdes contra o binário Rust; documentar como rodar.

## Regras

- Rust estável, sem `unsafe`, `clippy` sem avisos, `cargo fmt`. Dependências mínimas e auditáveis (`serde`, `serde_json`, `sha2`, `base64`, `axum`, `tokio`); justifique cada nova.
- Nenhum segredo no repositório. Não publicar nem fazer push.
- Datas: sem `chrono` no núcleo se der para evitar; minutos absolutos como no JS.
- Erros com `Result` e tipos próprios; nada de `unwrap()` fora de testes.

## Fora desta fase

Painel em Rust (fase 2), adaptador Worker, D1 e R2, e desligar o JavaScript.
