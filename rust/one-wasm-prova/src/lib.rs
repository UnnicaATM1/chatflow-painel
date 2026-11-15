//! Prova de portabilidade: o `one-core` (API completa do ONE) compilado para `wasm32-unknown-unknown` e executado de verdade.
//!
//! `prova()` monta o contexto com o repositório em memória e uma plataforma fixa, e faz requisições reais ao núcleo
//! (`tratar`). Devolve `0` se tudo deu o resultado esperado, ou o número (1, 2, ...) da primeira verificação que falhou.
//! O Node carrega o `.wasm` e chama `prova()` (ver `tests/wasm-prova.js`). Não há relógio nem rede: tudo vem da plataforma.

use one_core::{Config, Contexto, CorpoPronto, CorpoResp, Req, Tokens, tratar};
use one_store::Memoria;
use one_store::plataforma::Fixa;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

/// Executor mínimo: o repositório em memória nunca fica pendente, então um único `poll` basta (com folga).
fn bloquear<F: Future>(f: F) -> Option<F::Output> {
    let mut f = pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    for _ in 0..10_000 {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return Some(v);
        }
    }
    None
}

type Ctx = Contexto<Memoria>;

fn chamar(
    ctx: &Ctx,
    metodo: &str,
    url: &str,
    token: Option<&str>,
    corpo: Option<Value>,
    chave: Option<&str>,
) -> Option<(u16, Value)> {
    let mut headers = HashMap::new();
    if let Some(t) = token {
        headers.insert("authorization".to_string(), format!("Bearer {t}"));
    }
    if let Some(c) = chave {
        headers.insert("idempotency-key".to_string(), c.to_string());
    }
    let bytes = corpo.map(|c| c.to_string().into_bytes());
    let mut req = Req {
        metodo: metodo.into(),
        url: url.into(),
        headers,
        ip: "wasm".into(),
        fonte: Box::new(CorpoPronto(bytes)),
    };
    let resp = bloquear(tratar(ctx, &mut req))?;
    let corpo = match resp.corpo {
        CorpoResp::Json(j) => j,
        CorpoResp::Vazio | CorpoResp::Bytes(_) => Value::Null,
    };
    Some((resp.status, corpo))
}

fn verificar() -> Result<(), i32> {
    let plat = Arc::new(Fixa {
        agora: 1_763_177_150_538,
    });
    let repo = Memoria::nova(plat.clone(), None);
    let mut cfg = Config::nova(Tokens {
        integracao: Some("t".into()),
        ..Tokens::default()
    });
    cfg.admin_senha = Some("adm".into());
    let ctx: Ctx = Contexto::novo(repo, plat, cfg).map_err(|_| 1)?;
    let t = Some("t");
    let go = |m: &str, u: &str, tok: Option<&str>, c: Option<Value>, k: Option<&str>| {
        chamar(&ctx, m, u, tok, c, k).ok_or(2)
    };

    let (s, c) = go("GET", "/saude", None, None, None)?;
    if (s, c) != (200, json!({ "ok": true })) {
        return Err(3);
    }
    if go("GET", "/empresas", None, None, None)?.0 != 401 {
        return Err(4);
    }
    let (s, c) = go(
        "POST",
        "/empresas",
        t,
        Some(json!({ "nome": "Cantina" })),
        None,
    )?;
    if s != 201 || c["id"] != "empresa_1" {
        return Err(5);
    }
    if go(
        "POST",
        "/empresas/empresa_1/ambientes",
        t,
        Some(json!({ "nome": "salao" })),
        None,
    )?
    .0 != 201
    {
        return Err(6);
    }
    let (s, c) = go(
        "POST",
        "/empresas/empresa_1/mesas",
        t,
        Some(json!({ "ambiente": "salao", "capacidade": 4 })),
        None,
    )?;
    if s != 201 || c["id"] != "S1" {
        return Err(7);
    }
    let pedido =
        |h: &str, d: &str| json!({ "data": d, "horario": h, "pessoas": 2, "ambiente": "salao" });
    let (s, c) = go(
        "POST",
        "/empresas/empresa_1/reservas",
        t,
        Some(pedido("23:30", "2026-11-20")),
        Some("k1"),
    )?;
    if s != 201 || c["status"] != "confirmada" {
        return Err(8);
    }
    // a reserva das 23:30 cruza a meia-noite: 00:30 do dia seguinte ainda bate, 01:00 não
    let (s, c) = go(
        "POST",
        "/empresas/empresa_1/reservas",
        t,
        Some(pedido("00:30", "2026-11-21")),
        Some("k2"),
    )?;
    if s != 200 || c["status"] != "indisponivel" {
        return Err(9);
    }
    let (s, c) = go(
        "POST",
        "/empresas/empresa_1/reservas",
        t,
        Some(pedido("01:00", "2026-11-21")),
        Some("k3"),
    )?;
    if s != 201 || c["status"] != "confirmada" {
        return Err(10);
    }
    let (s, c) = go(
        "POST",
        "/empresas/empresa_1/reservas",
        t,
        Some(pedido("23:30", "2026-11-20")),
        Some("k1"),
    )?;
    if s != 201 || c["reservaId"] != 1 {
        return Err(11); // a mesma chave de idempotência devolve a mesma reserva
    }
    let (s, c) = go(
        "POST",
        "/empresas/empresa_1/conhecimento",
        t,
        Some(json!({ "tipo": "texto", "titulo": "Preços", "texto": "A pizza custa 50 reais" })),
        None,
    )?;
    if s != 201 || c["id"] != 1 {
        return Err(12);
    }
    let (s, c) = go(
        "GET",
        "/empresas/empresa_1/conhecimento/buscar?q=quanto%20custa%20a%20pizza%3F",
        t,
        None,
        None,
    )?;
    if s != 200 || c["total"] != 1 {
        return Err(13);
    }
    let (s, c) = go("GET", "/empresas/empresa_1/historico", t, None, None)?;
    if s != 200
        || c.as_array().is_none_or(|a| a.len() != 6)
        || c[0]["quando"] != "2025-11-15T03:25:50.538Z"
    {
        return Err(14);
    }
    let (s, c) = go("GET", "/empresas/empresa_1/contexto", t, None, None)?;
    if s != 200
        || !c["prompt"]
            .as_str()
            .is_some_and(|p| p.contains("A pizza custa 50 reais") && p.contains("Reservas de mesa"))
    {
        return Err(15);
    }
    Ok(())
}

/// Ponto de entrada para o WebAssembly: `0` = tudo certo; outro número = primeira verificação que falhou.
#[unsafe(no_mangle)]
pub extern "C" fn prova() -> i32 {
    match verificar() {
        Ok(()) => 0,
        Err(n) => n,
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn prova_passa_no_alvo_nativo() {
        assert_eq!(prova(), 0);
    }
}
