//! Datas e horários sem fuso (espelha `src/tempo.js`): minutos absolutos desde 1970-01-01 00:00 do relógio local.

use crate::util::{Res, erro};

fn bissexto(a: i64) -> bool {
    (a % 4 == 0 && a % 100 != 0) || a % 400 == 0
}

fn dias_no_mes(a: i64, m: i64) -> i64 {
    match m {
        2 if bissexto(a) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Dias desde 1970-01-01 (algoritmo de Howard Hinnant).
fn dias_de_civil(a: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { a - 1 } else { a };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `AAAA-MM-DD` + `HH:MM` -> minutos absolutos. Data impossível ou hora fora de 00:00 a 23:59 dá 400.
pub fn minutos_absolutos(data: &str, horario: &str) -> Res<i64> {
    if !crate::util::data_ok(data) || !crate::util::horario_ok(horario) {
        return erro(400, "data ou horário inválido");
    }
    let n = |s: &str| s.parse::<i64>().unwrap_or(-1);
    let (a, m, d) = (n(&data[0..4]), n(&data[5..7]), n(&data[8..10]));
    let (hh, mm) = (n(&horario[0..2]), n(&horario[3..5]));
    if !(1..=12).contains(&m) || d < 1 || d > dias_no_mes(a, m) || hh > 23 || mm > 59 {
        return erro(400, "data ou horário inválido");
    }
    Ok(dias_de_civil(a, m, d) * 1440 + hh * 60 + mm)
}

#[cfg(test)]
mod testes {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn virada_de_dia_mes_e_ano() {
        let m = |d, h| minutos_absolutos(d, h).unwrap();
        assert_eq!(m("2026-11-21", "00:30") - m("2026-11-20", "23:30"), 60);
        assert_eq!(m("2027-01-01", "00:00") - m("2026-12-31", "23:59"), 1);
        assert_eq!(m("2028-03-01", "00:00") - m("2028-02-29", "00:00"), 1440);
        assert_eq!(m("1970-01-01", "00:00"), 0);
    }

    #[test]
    fn datas_impossiveis_dao_400() {
        for (d, h) in [
            ("2026-02-30", "10:00"),
            ("2026-13-01", "10:00"),
            ("2026-11-20", "24:00"),
            ("2026-11-20", "10:60"),
            ("x", "10:00"),
        ] {
            assert_eq!(minutos_absolutos(d, h).unwrap_err().codigo, 400, "{d} {h}");
        }
    }

    #[test]
    fn mesmos_numeros_do_javascript() {
        // valor calculado com o JavaScript: Date.UTC(2026, 10, 20) / 60000 + 20 * 60
        assert_eq!(
            minutos_absolutos("2026-11-20", "20:00").unwrap(),
            29_920_080
        );
    }
}
