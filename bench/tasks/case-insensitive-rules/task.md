# Category rules should ignore case

My rule `{ "match": "starbucks", "category": "coffee" }` does not match `STARBUCKS #1234`. Rule matching in `categorize` should ignore upper and lower case. The first matching rule still wins.
