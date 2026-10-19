# Limit the summary to a range of months

Add `--from YYYY-MM` and `--to YYYY-MM` to `ledger summary`. Both are optional and inclusive, and they can be used together or alone. Months outside the range are left out of the output. A value that is not in `YYYY-MM` form makes the command print an error naming the bad value and return exit code 2 without printing a summary.
