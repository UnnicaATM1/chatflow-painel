//! `one-core`: domínio e API do ONE em Rust, sem I/O (espelha o JavaScript de `src/`).
//!
//! Tudo o que depende do ambiente (relógio, aleatoriedade, armazenamento) entra por traits de `one-store`.
//! O adaptador nativo fica em `one-node`.

pub mod agentes;
pub mod codigos;
pub mod conhecimento;
pub mod contexto;
pub mod historico;
pub mod mapa;
pub mod nucleo;
pub mod permissoes;
pub mod reservas;
pub mod tempo;
pub mod usuarios;
pub mod util;

pub use nucleo::{
    Config, Contexto, CorpoPronto, CorpoResp, FonteCorpo, LIMITE_CORPO, LIMITE_CORPO_ARQUIVO, Req,
    Resp, Tokens, cabecalhos_cors, tratar,
};
pub use util::{Erro, Res};
