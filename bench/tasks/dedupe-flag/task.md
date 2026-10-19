# Add a --dedupe flag for duplicate rows

When I merge exports from two downloads, some rows appear twice. Add `dedupe(transactions)` to `src/transactions.js`. It drops a transaction when an earlier one has the same date, description and amount, and keeps the order otherwise. Add `--dedupe` to the `summary` command to apply it before summarizing.
