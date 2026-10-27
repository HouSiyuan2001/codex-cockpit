//! Shared ledger dates use China standard time, never the host timezone.
use chrono::{DateTime, FixedOffset, NaiveDate, TimeZone};

pub const TIME_ZONE: &str = "Asia/Shanghai";

pub fn offset() -> FixedOffset {
    FixedOffset::east_opt(8 * 60 * 60).expect("China standard time offset")
}

pub fn calendar_day<T: TimeZone>(instant: &DateTime<T>) -> NaiveDate {
    instant.with_timezone(&offset()).date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_instant_has_the_same_day_across_us_offsets_and_dst() {
        for (timestamp, expected) in [
            ("2026-10-26T07:59:59-08:00", "2026-10-26"),
            ("2026-10-26T08:00:00-08:00", "2026-10-27"),
            ("2026-03-08T01:59:59-08:00", "2026-03-08"),
            ("2026-03-08T03:00:00-07:00", "2026-03-08"),
            ("2026-11-01T01:30:00-07:00", "2026-11-01"),
            ("2026-11-01T01:30:00-08:00", "2026-11-01"),
            ("2026-12-31T16:00:00Z", "2027-01-01"),
        ] {
            let instant = DateTime::parse_from_rfc3339(timestamp).unwrap();
            assert_eq!(calendar_day(&instant).to_string(), expected);
        }
    }
}
