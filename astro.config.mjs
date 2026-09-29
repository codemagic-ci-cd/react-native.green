import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://rn.green',
  output: 'static',
  trailingSlash: 'ignore',
  // A short class per scoped element instead of a data-astro-cid-* attribute: the package page
  // repeats its cells and panels for every version, so this keeps the HTML noticeably smaller.
  scopedStyleStrategy: 'class',
});
