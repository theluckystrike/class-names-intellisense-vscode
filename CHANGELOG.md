# Changelog

## Unreleased

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.1.0 (2026-11-09)

- First release: class and id completion from workspace CSS, SCSS, Less and PostCSS files, `<style>` blocks and `<link rel="stylesheet">` sheets.
- HTML, JSX/TSX (`className`, `clsx()`, `cn()`, `cva()` and more), Vue (`:class`), Svelte (`class:`), Angular (`[ngClass]`), Astro, PHP, Blade, Twig, ERB and other templates.
- CSS modules: `styles.` and `styles['...']` from the imported file, `$style.` for Vue `<style module>`.
- Hover shows the CSS rule; Go to Definition opens it.
- SCSS and Less nesting resolved (`&__title`, `&--big`, `&.is-on`).
- Background index with limits: node_modules, files.exclude and .gitignore skipped, 5,000 sheets, 2 MB per sheet. Only changed files are read again.
- Bundled Bootstrap 5.3 and Bulma 1.0 class lists (opt-in, offered once when a page loads them from a CDN).
- Unknown class hint, off by default.
