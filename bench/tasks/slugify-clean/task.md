# slugify should lowercase and trim dashes

`slugify('  Hello, World! ')` returns `Hello-World-`. It should return `hello-world`: lowercase, words joined by single dashes, and no leading or trailing dash.
