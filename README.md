# vite-plugin-rehost

[![npm](https://img.shields.io/npm/v/vite-plugin-rehost.svg)](https://www.npmjs.com/package/vite-plugin-rehost)
[![Code style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://paypal.me/alecdotbiz)

> Self-hosted resources from index.html

Any `<link rel="stylesheet">` and `<script>` elements that point to external URLs are fetched
at build time and saved to the `outDir` to be self-hosted. The resources will have a content 
hash in their name, so [`Cache-Control: immutable`](https://www.keycdn.com/blog/cache-control-immutable) can be used.

Within self-hosted `.css` files, any `url()` expressions that point to external URLs are also
fetched and saved to the `outDir` to be self-hosted.

**Note:** This plugin depends on [#1647](https://github.com/vitejs/vite/pull/1647)

&nbsp;

### Usage

```sh
yarn add vite-plugin-rehost -D
```

Within your `vite.config.js` file:

```ts
import rehost from 'vite-plugin-rehost'

export default {
  plugins: [
    rehost(),
  ]
}
```
