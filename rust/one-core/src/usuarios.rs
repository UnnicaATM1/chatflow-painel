//! Usuários: senha (PBKDF2-SHA256), validações e papéis. Espelha `src/usuarios.js`.
//! Nenhuma senha, hash ou token é registrado em log.

use one_store::{Credencial, Json};
use sha2::{Digest, Sha256};

pub const PAPEIS_USUARIO: [&str; 3] = ["equipe", "admin", "superadmin"];
/// Teto do Workers; o mesmo valor do JavaScript.
pub const ITERACOES_PBKDF2: u32 = 100_000;
pub const SENHA_MINIMA: usize = 10;
pub const SENHA_MAXIMA: usize = 200;

const BLOCO: usize = 64;

/// HMAC-SHA256 com os estados internos já preparados (a chave é fixa durante todas as iterações).
struct Hmac {
    interno: Sha256,
    externo: Sha256,
}

impl Hmac {
    fn novo(chave: &[u8]) -> Self {
        let mut k = [0u8; BLOCO];
        if chave.len() > BLOCO {
            k[..32].copy_from_slice(&Sha256::digest(chave));
        } else {
            k[..chave.len()].copy_from_slice(chave);
        }
        let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
        let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
        Self {
            interno: Sha256::new().chain_update(&ipad),
            externo: Sha256::new().chain_update(&opad),
        }
    }

    fn calcular(&self, partes: &[&[u8]]) -> [u8; 32] {
        let mut i = self.interno.clone();
        for p in partes {
            i.update(p);
        }
        let mut o = self.externo.clone();
        o.update(i.finalize());
        o.finalize().into()
    }
}

/// PBKDF2-HMAC-SHA256 de 32 bytes (um único bloco).
pub fn pbkdf2_sha256(senha: &[u8], sal: &[u8], iteracoes: u32) -> [u8; 32] {
    let h = Hmac::novo(senha);
    let mut u = h.calcular(&[sal, &1u32.to_be_bytes()]);
    let mut t = u;
    for _ in 1..iteracoes.max(1) {
        u = h.calcular(&[&u]);
        for (a, b) in t.iter_mut().zip(u.iter()) {
            *a ^= b;
        }
    }
    t
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn de_hex(t: &str) -> Option<Vec<u8>> {
    if !t.len().is_multiple_of(2) || !t.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return None;
    }
    (0..t.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&t[i..i + 2], 16).ok())
        .collect()
}

/// Deriva a chave de `senha` com o sal (hex). Hex de 32 bytes.
pub fn derivar_senha(senha: &str, salt_hex: &str, iteracoes: u32) -> Option<String> {
    let sal = de_hex(salt_hex)?;
    Some(hex(&pbkdf2_sha256(senha.as_bytes(), &sal, iteracoes)))
}

/// Credencial nova; `sal` opcional (hex) serve aos testes.
pub fn criar_credencial(senha: &str, sal: Vec<u8>) -> Credencial {
    let salt = hex(&sal);
    let senha_hash = derivar_senha(senha, &salt, ITERACOES_PBKDF2).unwrap_or_default();
    Credencial {
        senha_hash,
        salt,
        iteracoes: ITERACOES_PBKDF2,
    }
}

/// Compara em tempo constante.
pub fn conferir_senha(senha: &str, salt: &str, iteracoes: u32, senha_hash: &str) -> bool {
    derivar_senha(senha, salt, iteracoes)
        .is_some_and(|h| one_store::iguais_tempo_constante(&h, senha_hash))
}

pub fn normalizar_email(e: &str) -> String {
    e.trim().to_lowercase()
}

fn tam16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Mesma regra de `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` e no máximo 120 caracteres.
pub fn email_valido(e: &str) -> bool {
    if tam16(e) > 120 || e.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, dominio)) = e.split_once('@') else {
        return false;
    };
    if local.is_empty() || dominio.contains('@') {
        return false;
    }
    let cs: Vec<char> = dominio.chars().collect();
    cs.len() >= 3 && cs[1..cs.len() - 1].contains(&'.')
}

/// Mensagem de erro ou `None`.
pub fn validar_senha_nova(s: Option<&Json>) -> Option<String> {
    let Some(Json::String(s)) = s else {
        return Some(format!(
            "a senha precisa ter pelo menos {SENHA_MINIMA} caracteres"
        ));
    };
    let n = tam16(s);
    if n < SENHA_MINIMA {
        return Some(format!(
            "a senha precisa ter pelo menos {SENHA_MINIMA} caracteres"
        ));
    }
    if n > SENHA_MAXIMA {
        return Some(format!(
            "a senha pode ter no máximo {SENHA_MAXIMA} caracteres"
        ));
    }
    None
}

pub struct NovoUsuario {
    pub nome: String,
    pub email: String,
    pub papel: String,
    pub empresas: Vec<String>,
}

/// Valida o corpo de criação.
pub fn validar_novo_usuario(b: &Json) -> Result<NovoUsuario, String> {
    let Some(o) = b.as_object() else {
        return Err("corpo inválido".into());
    };
    let nome = o
        .get("nome")
        .and_then(Json::as_str)
        .map_or("", str::trim)
        .to_string();
    if nome.is_empty() || tam16(&nome) > 80 {
        return Err("nome de 1 a 80 caracteres".into());
    }
    let email = normalizar_email(o.get("email").and_then(Json::as_str).unwrap_or(""));
    if !email_valido(&email) {
        return Err("e-mail inválido".into());
    }
    let papel = o.get("papel").and_then(Json::as_str).unwrap_or("");
    if !PAPEIS_USUARIO.contains(&papel) {
        return Err("papel deve ser equipe, admin ou superadmin".into());
    }
    if let Some(e) = validar_senha_nova(o.get("senha")) {
        return Err(e);
    }
    let empresas = lista_de_ids(o.get("empresas"))
        .ok_or_else(|| "empresas deve ser uma lista de ids".to_string())?;
    Ok(NovoUsuario {
        nome,
        email,
        papel: papel.to_string(),
        empresas,
    })
}

/// `None` quando o campo existe mas não é lista de textos; ausente vira lista vazia. Sem repetidos, na ordem.
pub fn lista_de_ids(v: Option<&Json>) -> Option<Vec<String>> {
    let Some(v) = v else {
        return Some(Vec::new());
    };
    let a = v.as_array()?;
    let mut saida: Vec<String> = Vec::new();
    for x in a {
        let s = x.as_str()?.to_string();
        if !saida.contains(&s) {
            saida.push(s);
        }
    }
    Some(saida)
}

pub fn eh_superadmin(papel: &str) -> bool {
    papel == "superadmin" || papel == "integracao"
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn pbkdf2_vetor_conhecido() {
        // RFC 7914 §11: PBKDF2-HMAC-SHA-256("passwd", "salt", 1, 64) começa com 55ac046e56e3089f...
        let dk = pbkdf2_sha256(b"passwd", b"salt", 1);
        assert_eq!(hex(&dk), "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
    }

    #[test]
    fn validacoes() {
        assert!(email_valido("ana@x.com"));
        assert!(!email_valido("ana@x"));
        assert!(!email_valido("a na@x.com"));
        assert!(!email_valido("@x.com"));
        assert!(validar_senha_nova(Some(&Json::from("curta"))).is_some());
        assert!(validar_senha_nova(Some(&Json::from("senha-forte-123"))).is_none());
    }
}
