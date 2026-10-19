# CSV import breaks on descriptions with commas

My bank export quotes descriptions that contain commas, like:

```
date,description,amount
2026-03-04,"Coffee, large",5.25
```

`parseCsv` splits that row in the wrong place, so the description becomes `"Coffee` and the amount is wrong. Quoted fields should be read as one cell, and a doubled quote (`""`) inside a quoted field is a literal quote. Plain unquoted rows must keep working.
