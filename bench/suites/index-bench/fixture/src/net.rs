pub fn parse_port(raw: &str) -> u16 {
    raw.parse().unwrap_or(3000)
}

pub fn backoff_ms(attempt: u32) -> u64 {
    100 * 2u64.pow(attempt.min(6))
}
