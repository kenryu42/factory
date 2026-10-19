---
base: f1a6e79b1444686e1f0cc6edc601834259d574db
check: test/zz-bench-check.test.js
grade: node --test --test-reporter=spec --test-timeout=120000
---
# Refunds print as $-12.00

`formatMoney(-12)` returns `$-12.00`. It should be `-$12.00`. Positive amounts should not change.
