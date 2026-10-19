# Show each category's share of the month

Add a `--percent` flag to `ledger summary`. With it, each category line ends with two spaces and that category's share of the month as a whole percent, like `  groceries        $70.17  5%`.

- Shares are computed over the categories whose total is positive that month. A category with a zero or negative total gets no percent.
- The percents of a month must add up to exactly 100. Round down every share, then hand the missing points one by one to the categories with the largest fractional parts (ties go to the category that sorts first by name).
- Without `--percent` the output does not change.
