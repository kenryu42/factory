# Add a budget command

I want to know when I overspend. Add a command:

```
ledger budget <file.csv> --budgets <budgets.json> [--rules <rules.json>]
```

`budgets.json` maps a category to a monthly limit in dollars, like `{ "coffee": 20, "groceries": 300 }`. For every month and every budgeted category whose spending is over the limit, print a line like `2026-03 coffee over by $4.95` (months in order, then categories in alphabetical order). If anything is over, the command returns exit code 1. If nothing is over, print `All categories within budget.` and return 0. Categories without a budget are ignored.
