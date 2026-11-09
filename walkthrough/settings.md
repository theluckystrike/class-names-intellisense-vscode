# Limits and excludes

The index skips `node_modules`, `files.exclude` and the root `.gitignore`. It stops at 5,000 style sheets and skips sheets over 2 MB without reading them.

- `htmlCssClass.exclude`: more folders to skip.
- `htmlCssClass.includePackages`: packages in node_modules to index anyway, for example `bootstrap`.
- `htmlCssClass.maxFiles` and `htmlCssClass.maxFileSizeKB`: the limits.

Run the command "Class Names IntelliSense: Show index report" to see what was read and what was skipped.
