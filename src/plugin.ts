import type { Plugin } from 'vite'
import urlRegex from 'url-regex'
import MagicString from 'magic-string'
import { relative } from '@cush/relative'
import cheerio from 'cheerio'
import fetch from 'node-fetch'
import path from 'path'
import fs from 'fs'
import { URL } from 'url'
import { createHash } from 'crypto'

const debug = require('debug')('vite-rehost')

type Element = ReturnType<typeof cheerio>
type FileCache = { [file: string]: string | Buffer }

export default (): Plugin => {
  const files: FileCache = {}
  const emitCache = new Map<string, string>()

  return {
    name: 'vite:rehost',
    apply: 'build',
    enforce: 'pre',
    configResolved({ root, base, build: { assetsDir, outDir } }) {
      let useEmitFile = true

      this.resolveBuiltUrl = function (id) {
        const source = files[id]
        if (source == null) {
          return null
        }
        let assetId = emitCache.get(id)
        if (!assetId) {
          const fileName = getFileName(
            id.slice(1),
            getAssetHash(source),
            assetsDir
          )
          if (!useEmitFile) {
            emitCache.set(id, path.resolve(root, outDir, fileName))
            return base + fileName
          }
          assetId = this.emitFile({
            type: 'asset',
            fileName,
            source,
          })
          // Vite replaces __VITE_ASSET__ imports in its default plugins
          emitCache.set(id, (assetId = `__VITE_ASSET__${assetId}__`))
        }
        return assetId
      }

      this.writeBundle = () => {
        // No files have been emitted yet? That means we need
        // to write files manually in the `closeBundle` phase.
        if (!emitCache.size) {
          useEmitFile = false
        }
      }

      this.closeBundle = async function () {
        if (!useEmitFile)
          for (const [id, source] of Object.entries(files)) {
            const filePath = emitCache.get(id)
            if (filePath) {
              fs.mkdirSync(path.dirname(filePath), { recursive: true })
              fs.writeFileSync(filePath, source)
            }
          }

        // Clear the emit cache so `emitFile` is called
        // again on rebuilds (in watch mode).
        emitCache.clear()
      }
    },
    resolveId(id) {
      if (files[id]) {
        return id
      }
    },
    // Self-hosted files may be bundled.
    load(id) {
      return files[id]?.toString()
    },
    transformIndexHtml: {
      enforce: 'pre',
      async transform(html) {
        const $ = cheerio.load(html)
        const loading: Promise<void>[] = []

        $('link[rel="stylesheet"]').each((_i, el) => {
          const url = $(el).attr('href')
          if (url && isExternalUrl(url)) {
            loading.push(fetchStyles(url, $(el), files))
          }
        })

        $('script[src]').each((_i, el) => {
          const url = $(el).attr('src')
          if (url && isExternalUrl(url)) {
            loading.push(fetchScript(url, $(el), files))
          }
        })

        await Promise.all(loading)
        return $.html()
      },
    },
  }
}

async function fetchStyles(url: string, el: Element, files: FileCache) {
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

async function fetchScript(url: string, el: Element, files: FileCache) {
  const file = toFilePath(url)
  el.attr('src', file)

  if (files[file] == null) {
    files[file] = ''
    files[file] = await fetchText(url)
  }
}

function isExternalUrl(url: string) {
  return urlRegex().test(url)
}

const textCache: { [url: string]: Promise<string> } = {}
const bufferCache: { [url: string]: Promise<Buffer> } = {}

function fetchText(url: string) {
  return textCache[url] || (textCache[url] = fetch(url).then(res => res.text()))
}

function fetchBuffer(url: string) {
  return (
    bufferCache[url] ||
    (bufferCache[url] = fetch(url).then(res => res.buffer()))
  )
}

async function fetchAsset(url: string, files: FileCache) {
  const file = toFilePath(url)
  if (files[file] == null) {
    files[file] = ''
    files[file] = await fetchBuffer(url)
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
      debug(`resolve "${prevUrl}" to "${url}"`)
    } else if (!isExternalUrl(url)) {
      url = parentUrl.slice(0, parentUrl.lastIndexOf('/') + 1) + url
      debug(`resolve "${prevUrl}" to "${url}"`)
    }
    if (isExternalUrl(url)) {
      url = replacer(url)
      debug(`save as "${url}"`)
      editor.overwrite(
        match.index + 4,
        match.index + match[0].length - 1,
        JSON.stringify(url)
      )
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
    file += host + decodeURIComponent(pathname)
  }

  return file
}

function getFileName(file: string, contentHash: string, assetsDir: string) {
  const ext = path.extname(file)
  return path.posix.join(
    assetsDir,
    `${file.slice(0, -ext.length)}.${contentHash}${ext}`
  )
}

function getAssetHash(content: string | Buffer) {
  return createHash('sha256').update(content).digest('hex').slice(0, 8)
}
