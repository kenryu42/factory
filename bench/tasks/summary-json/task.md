# Add a --json flag to the summary command

I want to feed the summary into another script. `ledger summary <file> --json` (with or without `--rules`) should print a single line of JSON instead of the table: the same object `summarizeByMonth` returns, with every amount rounded to 2 decimals. Without `--json` the output stays the same.
