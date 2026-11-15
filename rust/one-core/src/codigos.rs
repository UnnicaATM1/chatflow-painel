//! Codificações pequenas usadas pelo núcleo.

use base64::Engine;

/// base64url sem padding (como `Buffer.toString('base64url')`).
pub fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn base64url_sem_padding() {
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
        assert_eq!(base64url(&[1]), "AQ");
    }
}
