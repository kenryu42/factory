# wordCount miscounts extra whitespace

`wordCount('one  two')` returns 3 and `wordCount('')` returns 1. Words can be separated by any run of spaces, tabs or newlines, and leading or trailing whitespace should not count. An empty or whitespace-only string has 0 words.
