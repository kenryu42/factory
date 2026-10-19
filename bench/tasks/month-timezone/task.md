# Transactions land in the wrong month depending on timezone

A friend in California ran `ledger summary` on the example file and the rent paid on 2026-03-01 showed up under `2026-02`. On my machine it is correct. The month a transaction belongs to should come from its `YYYY-MM-DD` date, no matter what timezone the computer is in.
