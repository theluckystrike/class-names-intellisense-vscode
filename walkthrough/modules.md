# CSS modules, helper functions and frameworks

- `import styles from './Button.module.css'` and then `styles.` lists the classes of that file only. A name with a dash is inserted as `styles['btn-primary']`.
- Vue `<style module>`: `$style.` lists the classes of that block.
- Strings inside `clsx()`, `cn()`, `cx()`, `classnames()`, `twMerge()`, `cva()` and `tv()` complete class names. Add your own helpers in the setting `htmlCssClass.classFunctions`.
- A page that loads Bootstrap 5 or Bulma from a CDN can use the bundled class list. The extension asks once; you can also set `htmlCssClass.frameworks`. Nothing is downloaded.
