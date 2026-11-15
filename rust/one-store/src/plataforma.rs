//! Tudo o que o núcleo precisa do ambiente: relógio e aleatoriedade. Sem `std::time` nem `getrandom` aqui.

/// Interface da plataforma (espelha `src/plataforma.js`). O adaptador nativo implementa com o relógio e o
/// gerador do sistema; os testes, com valores fixos.
pub trait Plataforma: Send + Sync {
    /// Milissegundos desde 1970-01-01 UTC.
    fn agora_ms(&self) -> i64;
    /// `n` bytes criptograficamente aleatórios.
    fn aleatorio(&self, n: usize) -> Vec<u8>;
}

/// UUID v4 a partir de 16 bytes aleatórios.
pub fn uuid(p: &dyn Plataforma) -> String {
    let mut b = p.aleatorio(16);
    b.resize(16, 0);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        h[0..4].concat(),
        h[4..6].concat(),
        h[6..8].concat(),
        h[8..10].concat(),
        h[10..16].concat()
    )
}

/// Igual a `new Date(ms).toISOString()`: `2026-11-15T03:25:50.538Z`.
pub fn iso_ms(ms: i64) -> String {
    let dias = ms.div_euclid(86_400_000);
    let resto = ms.rem_euclid(86_400_000);
    let (a, m, d) = civil_de_dias(dias);
    let (h, mi, s, milis) = (
        resto / 3_600_000,
        (resto / 60_000) % 60,
        (resto / 1000) % 60,
        resto % 1000,
    );
    format!("{a:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milis:03}Z")
}

/// Dias desde 1970-01-01 para (ano, mês, dia) (algoritmo de Howard Hinnant).
fn civil_de_dias(dias: i64) -> (i64, i64, i64) {
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Plataforma fixa para testes: relógio e "aleatório" determinísticos.
#[derive(Debug, Clone, Copy)]
pub struct Fixa {
    pub agora: i64,
}

impl Plataforma for Fixa {
    fn agora_ms(&self) -> i64 {
        self.agora
    }
    fn aleatorio(&self, n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 7 + 3) as u8).collect()
    }
}

#[cfg(test)]
mod testes {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn iso_igual_ao_javascript() {
        assert_eq!(iso_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_ms(1_763_177_150_538), "2025-11-15T03:25:50.538Z");
        assert_eq!(iso_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_ms(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn uuid_tem_formato_v4() {
        let u = uuid(&Fixa { agora: 0 });
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!(matches!(&u[19..20], "8" | "9" | "a" | "b"));
    }
}
