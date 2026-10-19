# CSV import fails on Windows exports and multi-line notes

Exports from my bank's Windows app break the importer in two ways:

- Lines end with `\r\n`, so the last column keeps a stray `\r`.
- A quoted description can span several lines, like `"Dinner\nwith team"`.

Make `parseCsv` follow the usual CSV rules: a quoted field can contain commas, doubled quotes (`""` is one `"`), and line breaks; rows end with `\n` or `\r\n`; the final line break is optional; empty lines between rows are skipped. Unquoted fields stay trimmed as they are today.
