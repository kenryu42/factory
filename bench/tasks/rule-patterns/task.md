# Category rules need patterns and amount limits

Substring rules are not enough. Extend the rules file so a rule can use:

- `pattern`: a regular expression tested against the description, ignoring case, used instead of `match`.
- `min` and `max`: optional amount limits, both inclusive. The rule only applies when the amount is inside them.

`categorize(description, rules, amount)` takes the transaction amount as a third argument, and `loadTransactions` passes it. Existing `match` rules keep working exactly as before, and the first rule that applies still wins. A rule whose `pattern` is not a valid regular expression must make `categorize` throw an error that includes the bad pattern, instead of silently never matching.
