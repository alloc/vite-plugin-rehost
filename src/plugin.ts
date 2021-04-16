import type { Plugin } from 'vite'
import urlRegex from 'url-regex'
import MagicString from 'magic-string'
import { relative } from '@cush/relative'
import cheerio from 'cheerio'
import fetch from 'node-fetch'
import { URL } from 'url'

type Element = ReturnType<typeof cheerio>
type FileCache = { [file: string]: string }

export default (): Plugin => {
  const files: FileCache = {}
  const emitCache = new Map<string, string>()

  return {
    name: 'vite:rehost',
    apply: 'build',
    enforce: 'pre',
    resolveBuiltUrl(id) {
      const source = files[id]
      if (source == null) {
        return null
      }
      let assetId = emitCache.get(id)
      if (!assetId) {
        assetId = this.emitFile({
          type: 'asset',
          name: id.slice(1),
          source,
        })
        // Vite replaces __VITE_ASSET__ imports in its default plugins
        emitCache.set(id, (assetId = `__VITE_ASSET__${assetId}__`))
      }
      return assetId
    },
    resolveId(id) {
      if (files[id]) {
        return id
      }
    },
    // Self-hosted files may be bundled.
    load(id) {
      return files[id]
    },
    transformIndexHtml: {
      enforce: 'pre',
      async transform(html) {
        const loading: Promise<void>[] = []

        const $ = cheerio.load(html)

        async function fetchStyles(url: string, el: Element) {
          const file = toFilePath(url)
          el.attr('href', file)

          if (files[file] == null) {
            files[file] = ''

            const loading: Promise<void>[] = []

            const parentUrl = url
            const text = await fetchText(url)
            files[file] = replaceCssUrls(text, parentUrl, url => {
              loading.push(fetchAsset(url, files))
              return toFilePath(url)
            })

            await Promise.all(loading)
          }
        }
        $('link[rel="stylesheet"]').each((_i, el) => {
          const url = $(el).attr('href')
          if (url && isExternalUrl(url)) {
            loading.push(fetchStyles(url, $(el)))
          }
        })

        async function fetchScript(url: string, el: Element) {
          const file = toFilePath(url)
          el.attr('src', file)

          if (files[file] == null) {
            files[file] = ''
            files[file] = await fetchText(url)
          }
        }
        $('script[src]').each((_i, el) => {
          const url = $(el).attr('src')
          if (url && isExternalUrl(url)) {
            loading.push(fetchScript(url, $(el)))
          }
        })

        await Promise.all(loading)
        return $.html()
      },
    },
  }
}

function isExternalUrl(url: string) {
  return urlRegex().test(url)
}

const fetched: { [url: string]: Promise<string> } = {}

function fetchText(url: string) {
  return fetched[url] || (fetched[url] = fetch(url).then(res => res.text()))
}

async function fetchAsset(url: string, files: FileCache) {
  const file = toFilePath(url)
  if (files[file] == null) {
    files[file] = ''
    files[file] = await fetchText(url)
  }
}

function replaceCssUrls(
  text: string,
  parentUrl: string,
  replacer: (url: string) => string
) {
  const editor = new MagicString(text)
  const cssUrlRE = /url\(\s*('[^']+'|"[^"]+"|[^'")]+)\s*\)/g
  for (;;) {
    const match = cssUrlRE.exec(text)
    if (!match) {
      return editor.toString()
    }
    let url = match[1]
    if (/^['"]/.test(url)) {
      url = url.slice(1, -1)
    }
    const prevUrl = url
    if (/^\.\.?\//.test(url)) {
      url = relative(parentUrl, url) || url
    } else if (!isExternalUrl(url)) {
      url = parentUrl.slice(0, parentUrl.lastIndexOf('/') + 1) + url
    }
    if (isExternalUrl(url)) {
      url = replacer(url)
      editor.overwrite(match.index + 4, match.index + match[0].length - 1, url)
    }
  }
}

function toFilePath(url: string) {
  let file = '/'

  const { host, pathname, searchParams } = new URL(url)
  if (host == 'www.googletagmanager.com') {
    file += `${host}/gtag.js`
  } else if (host == 'fonts.googleapis.com') {
    const [family] = searchParams.get('family')!.split(':')
    file += `${host}/${family}.css`
  } else {
    file += host + pathname
  }

  return file
}
