# Show me my recurring payments

I keep forgetting about subscriptions. Add `findRecurring(transactions)` in a new `src/recurring.js`. A payment is recurring when the same description and the same amount appear in at least two different months. Return one entry per recurring payment as `{ description, amount, months }`, where `months` is the sorted list of distinct `YYYY-MM` months it appears in. Sort the entries by description. Refunds (negative amounts) are never recurring.
