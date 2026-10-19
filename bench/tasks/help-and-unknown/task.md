# The CLI is silent on --help and unknown commands

`ledger --help`, `ledger` with no arguments, and `ledger frobnicate` all print nothing and exit 0. Make `--help` and no arguments print a usage text that starts with `Usage: ledger` and lists the commands, with exit code 0. An unknown command should print an error that names the command plus the usage text, and return exit code 2.
