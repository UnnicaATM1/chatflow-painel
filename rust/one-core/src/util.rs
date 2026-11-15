//! Erros do núcleo e pequenas funções que reproduzem o comportamento do JavaScript do ONE.

use serde_json::Value as Json;

/// Erro com status HTTP. Vira `{ "erro": mensagem }` na resposta (mesmo contrato do JavaScript).
#[derive(Debug, Clone, PartialEq)]
pub struct Erro {
    pub codigo: u16,
    pub msg: String,
}

pub type Res<T> = Result<T, Erro>;

pub fn erro<T>(codigo: u16, msg: impl Into<String>) -> Res<T> {
    Err(Erro {
        codigo,
        msg: msg.into(),
    })
}

pub fn err(codigo: u16, msg: impl Into<String>) -> Erro {
    Erro {
        codigo,
        msg: msg.into(),
    }
}

/// `[...s].length` do JavaScript: caracteres reais (não unidades UTF-16).
pub fn tam(s: &str) -> usize {
    s.chars().count()
}

/// Comprimento em unidades UTF-16 (`s.length` do JavaScript).
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(inicio, fim)` do JavaScript (em unidades UTF-16).
pub fn slice16(s: &str, inicio: usize, fim: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    let fim = fim.min(u.len());
    if inicio >= fim {
        return String::new();
    }
    String::from_utf16_lossy(&u[inicio..fim])
}

/// `String(valor)` do JavaScript para valores vindos de JSON (`undefined` quando ausente).
pub fn js_string(v: Option<&Json>) -> String {
    match v {
        None => "undefined".into(),
        Some(Json::Null) => "null".into(),
        Some(Json::String(s)) => s.clone(),
        Some(Json::Bool(b)) => b.to_string(),
        Some(Json::Number(n)) => n.to_string(),
        Some(Json::Array(a)) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(Some(x))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Json::Object(_)) => "[object Object]".into(),
    }
}

/// `Number.isInteger(v)`: número JSON sem parte fracionária (4.0 vale).
pub fn inteiro(v: Option<&Json>) -> Option<i64> {
    let n = v?.as_number()?;
    if let Some(i) = n.as_i64() {
        return Some(i);
    }
    let f = n.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15).then_some(f as i64)
}

/// Valor "truthy" do JavaScript.
pub fn verdadeiro(v: Option<&Json>) -> bool {
    match v {
        None | Some(Json::Null) => false,
        Some(Json::Bool(b)) => *b,
        Some(Json::String(s)) => !s.is_empty(),
        Some(Json::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

/// `a || b` para texto: o valor se for "truthy" (convertido com `String()`), senão `None`.
pub fn texto_ou_nada(v: Option<&Json>) -> Option<String> {
    verdadeiro(v).then(|| js_string(v))
}

/// `/^\d{4}-\d{2}-\d{2}$/`
pub fn data_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// `/^\d{2}:\d{2}$/`
pub fn horario_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b.iter().enumerate().all(|(i, c)| {
            if i == 2 {
                *c == b':'
            } else {
                c.is_ascii_digit()
            }
        })
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// `decodeURIComponent`: `None` quando a sequência `%` é inválida ou o UTF-8 resultante é inválido (URIError).
pub fn decodificar_uri(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let (h, l) = (
                b.get(i + 1).copied().and_then(hex)?,
                b.get(i + 2).copied().and_then(hex)?,
            );
            out.push(h * 16 + l);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Decodificação indulgente de `URLSearchParams`: `+` vira espaço; `%` inválido fica como está.
fn decodificar_query(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' => {
                if let (Some(h), Some(l)) = (
                    b.get(i + 1).copied().and_then(hex),
                    b.get(i + 2).copied().and_then(hex),
                ) {
                    out.push(h * 16 + l);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Pares `chave=valor` da query (como `URL.searchParams`).
pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (decodificar_query(k), decodificar_query(v)),
            None => (decodificar_query(p), String::new()),
        })
        .collect()
}

/// `encodeURIComponent`.
pub fn codificar_uri(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod testes {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn uri_e_query() {
        assert_eq!(decodificar_uri("a%20b%C3%A7").unwrap(), "a bç");
        assert!(decodificar_uri("%E0%A4%A").is_none());
        assert!(decodificar_uri("%FF").is_none());
        assert_eq!(codificar_uri("Cardápio 1.txt"), "Card%C3%A1pio%201.txt");
        assert_eq!(
            parse_query("q=a+b%C3%A7&x=%zz&y"),
            vec![
                ("q".into(), "a bç".into()),
                ("x".into(), "%zz".into()),
                ("y".into(), String::new())
            ]
        );
    }

    #[test]
    fn js_numeros_e_textos() {
        assert_eq!(inteiro(Some(&serde_json::json!(4.0))), Some(4));
        assert_eq!(inteiro(Some(&serde_json::json!(4.5))), None);
        assert_eq!(inteiro(Some(&serde_json::json!("4"))), None);
        assert_eq!(slice16("aé😀b", 0, 3), "aé\u{fffd}");
        assert_eq!(tam("a😀"), 2);
        assert_eq!(len16("a😀"), 3);
        assert!(
            data_ok("2026-11-20")
                && !data_ok("2026-11-2")
                && horario_ok("09:05")
                && !horario_ok("9:05")
        );
    }
}
