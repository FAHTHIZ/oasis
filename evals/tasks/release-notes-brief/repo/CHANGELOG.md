# Changelog

## 2.3.0 - 2026-11-02

- Breaking: the `--legacy-auth` flag was removed; use `--auth token` instead.
- Added CSV export for invoices.
- Fixed a crash when a customer name contained an emoji.
- Internal: moved the build to a new CI runner.
- Faster search on accounts with more than 10,000 invoices.
- Chore: bumped development dependencies.

## 2.2.1 - 2026-10-15

- Fixed rounding of tax totals in PDF invoices.
- Internal: refactored the mailer.
