//! Small shared types and helpers. No external crate API is used in this file.
//!
//! Square index convention used everywhere in KAIROS code (not the crate's):
//! `idx = rank * 8 + file`, so a1 = 0, h1 = 7, a8 = 56, h8 = 63.
//! Mailbox piece codes: 0 empty, 1 pawn, 2 knight, 3 bishop, 4 rook, 5 queen,
//! 6 king; white pieces are positive, black pieces negative.

pub type Sq = usize;

pub const PIECE_VALUE_CP: [i32; 7] = [0, 100, 320, 330, 500, 900, 20000];
pub const MATE: i32 = 30000;

pub fn file_of(s: Sq) -> usize {
    s & 7
}

pub fn rank_of(s: Sq) -> usize {
    s >> 3
}

pub fn value_of(piece: i8) -> i32 {
    PIECE_VALUE_CP[piece.unsigned_abs() as usize]
}

pub fn clamp_f(value: f64, low: f64, high: f64) -> f64 {
    if value.is_nan() {
        return 0.0;
    }
    if value < low {
        low
    } else if value > high {
        high
    } else {
        value
    }
}

/// A move in standard UCI terms. `promo` is 0 or a piece code 2..=5.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mv {
    pub from: u8,
    pub to: u8,
    pub promo: u8,
}

pub fn sq_name(s: Sq) -> String {
    let file = (b'a' + (s & 7) as u8) as char;
    let rank = (b'1' + (s >> 3) as u8) as char;
    format!("{}{}", file, rank)
}

pub fn parse_sq(text: &str) -> Option<Sq> {
    let bytes = text.as_bytes();
    if bytes.len() != 2 {
        return None;
    }
    if bytes[0] < b'a' || bytes[0] > b'h' || bytes[1] < b'1' || bytes[1] > b'8' {
        return None;
    }
    Some(((bytes[1] - b'1') as usize) * 8 + (bytes[0] - b'a') as usize)
}

pub fn promo_char(code: u8) -> Option<char> {
    match code {
        2 => Some('n'),
        3 => Some('b'),
        4 => Some('r'),
        5 => Some('q'),
        _ => None,
    }
}

impl Mv {
    pub fn uci(&self) -> String {
        let mut out = sq_name(self.from as usize);
        out.push_str(&sq_name(self.to as usize));
        if let Some(c) = promo_char(self.promo) {
            out.push(c);
        }
        out
    }

    pub fn parse(text: &str) -> Option<Mv> {
        if text.len() != 4 && text.len() != 5 {
            return None;
        }
        if !text.is_ascii() {
            return None;
        }
        let from = parse_sq(&text[0..2])?;
        let to = parse_sq(&text[2..4])?;
        let promo = if text.len() == 5 {
            match text.as_bytes()[4] {
                b'n' => 2,
                b'b' => 3,
                b'r' => 4,
                b'q' => 5,
                _ => return None,
            }
        } else {
            0
        };
        Some(Mv {
            from: from as u8,
            to: to as u8,
            promo,
        })
    }
}

pub fn piece_char(piece: i8) -> char {
    let c = match piece.unsigned_abs() {
        1 => 'p',
        2 => 'n',
        3 => 'b',
        4 => 'r',
        5 => 'q',
        6 => 'k',
        _ => '?',
    };
    if piece > 0 {
        c.to_ascii_uppercase()
    } else {
        c
    }
}

/// Minimal JSON helpers (no serde dependency).
pub fn json_str(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn json_num(value: f64) -> String {
    if value.is_finite() {
        format!("{:.4}", value)
    } else {
        "0".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_names_round_trip() {
        for s in 0..64usize {
            assert_eq!(parse_sq(&sq_name(s)), Some(s));
        }
        assert_eq!(parse_sq("a1"), Some(0));
        assert_eq!(parse_sq("h8"), Some(63));
        assert_eq!(parse_sq("i1"), None);
    }

    #[test]
    fn uci_round_trip() {
        for text in ["e2e4", "e7e8q", "a7a8n", "e1g1"] {
            let m = Mv::parse(text).expect("parses");
            assert_eq!(m.uci(), text);
        }
        assert!(Mv::parse("e2e").is_none());
        assert!(Mv::parse("e7e8x").is_none());
    }

    #[test]
    fn json_escapes() {
        assert_eq!(json_str("a\"b"), "\"a\\\"b\"");
        assert_eq!(json_num(f64::NAN), "0");
    }
}
