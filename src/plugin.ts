import type { Plugin } from 'vite'
import MagicString from 'magic-string'
import cheerio from 'cheerio'
import fetch from 'node-fetch'
import { URL } from 'url'

export default (): Plugin => {
  const files: FileCache = {}
  let isBuild: boolean

  return {
    name: 'vite:rehost',
    enforce: 'pre',
    configResolved({ command }) {
      isBuild = command == 'build'
      if (isBuild) {
        this.resolveId = id => (files[id] == null ? void 0 : id)
        this.load = id => files[id]
      }
    },
    transformIndexHtml: {
      enforce: 'pre',
      async transform(html) {
        if (!isBuild) return
        const loading: Promise<void>[] = []

        const $ = cheerio.load(html)

        async function fetchStyles(url: string, el: Element) {
          const file = toFilePath(url)
          el.attr('href', file)

          if (files[file] == null) {
            files[file] = ''

            const loading: Promise<void>[] = []

            const text = await fetchText(url)
            files[file] = replaceCssUrls(text, url => {
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
  return /^(https?:)?\/\//.test(url)
}

function fetchText(url: string) {
  return fetch(url).then(res => res.text())
}

type FileCache = { [file: string]: string }

type Element = ReturnType<ReturnType<typeof cheerio.load>['root']>

async function fetchAsset(url: string, files: FileCache) {
  const file = toFilePath(url)
  if (files[file] == null) {
    files[file] = ''
    files[file] = await fetchText(url)
  }
}

function replaceCssUrls(text: string, replacer: (url: string) => string) {
  const editor = new MagicString(text)
  const cssUrlRE = /url\(\s*('[^']+'|"[^"]+"|[^'")]+)\s*\)/g
  for (;;) {
    const match = cssUrlRE.exec(text)
    if (!match) {
      return editor.toString()
    }
    const url = match[1]
    if (isExternalUrl(url))
      editor.overwrite(
        match.index + 4,
        match.index + match[0].length - 1,
        replacer(url)
      )
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
