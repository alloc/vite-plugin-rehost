import chalk from 'chalk'
import cheerio from 'cheerio'
import MagicString from 'magic-string'
import { startTask } from 'misty/task'
import fetch, { Response } from 'node-fetch'
import { URL } from 'url'
import urlRegex from 'url-regex'
import { relative } from '@cush/relative'
import { debug } from './debug'

type Element = ReturnType<typeof cheerio>
type FileCache = { [id: string]: FilePromise }
type FilePromise = Promise<string | Buffer>
type FileLoader = () => FilePromise

export class AsyncFileCache {
  private files: FileCache = {}
  private filesPromise: Promise<any> = Promise.resolve()
  private loaders: { [id: string]: FileLoader } = {}
  private requests: { [url: string]: Promise<Response> } = {}

  constructor(private toPublicUrl: (url: string) => string | Promise<string>) {}

  has(id: string) {
    return id in this.files || id in this.loaders
  }
  get(id: string) {
    let file = this.files[id]
    if (!file) {
      const loadFile = this.loaders[id]
      if (loadFile) {
        debug(`loading file: ${id}`)
        this.set(id, (file = loadFile()))
        delete this.loaders[id]
      }
    }
    return file
  }
  set(id: string, promise: Promise<string | Buffer>) {
    this.files[id] = promise
    const prevPromise = this.filesPromise
    this.filesPromise = promise.then(() => prevPromise)
  }
  async entries() {
    let promise: Promise<any> | undefined
    while (promise !== (promise = this.filesPromise)) {
      await promise
    }
    return Promise.all(
      Object.entries(this.files).map(file =>
        file[1].then(source => [file[0], source] as const)
      )
    )
  }
  /** File paths for assets that were never accessed with `.get` */
  get unusedAssets() {
    return Object.keys(this.loaders).filter(id => !this.files[id])
  }
  fetchStyles(cssRef: Element) {
    const cssUrl = cssRef.attr('href')
    if (cssUrl && isExternalUrl(cssUrl)) {
      const file = toFilePath(cssUrl)
      cssRef.attr('href', file)

      if (!this.has(file)) {
        debug(`found stylesheet: ${cssUrl}`)
        this.loaders[file] = () =>
          this.fetchText(cssUrl).then(cssText =>
            replaceCssUrls(cssText, cssUrl, url => {
              return this.fetchAsset(url)
            })
          )
      }
    }
  }
  fetchScript(scriptRef: Element) {
    const scriptUrl = scriptRef.attr('src')
    if (scriptUrl && isExternalUrl(scriptUrl)) {
      const file = toFilePath(scriptUrl)
      scriptRef.attr('src', file)

      if (!this.has(file)) {
        debug(`found script: ${scriptUrl}`)
        this.loaders[file] = () => this.fetchText(scriptUrl)
      }
    }
  }
  fetchAsset(assetUrl: string) {
    const file = toFilePath(assetUrl)
    if (!this.has(file)) {
      debug(`found asset: ${assetUrl}`)
      this.loaders[file] = () => this.fetchBuffer(assetUrl)
    }
    return this.toPublicUrl(file)
  }
  fetchText(url: string) {
    return this.fetch(url).then(res => res.text())
  }
  fetchBuffer(url: string) {
    return this.fetch(url).then(res => res.buffer())
  }
  private fetch(url: string) {
    let request = this.requests[url]
    if (request) {
      return request
    }
    const task = startTask('Downloading ' + chalk.yellowBright(url))
    const download = (): Promise<Response> =>
      fetch(url, {
        headers: {
          // An explicit user agent ensures the most modern asset is cached.
          // In the future, we may want to send a duplicate request with an
          // antiquated user agent, so backwards compatibility is preserved.
          // This workaround is mostly relevant to Google Fonts, where "ttf"
          // fonts are served to browsers where "woff2" is not supported.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:93.0) Gecko/20100101 Firefox/93.0',
        },
      }).catch(err => {
        // Connection may reset when debugging.
        if (err.code == 'ECONNRESET') {
          return download()
        }
        throw err
      })

    request = this.requests[url] = download()
    return request.finally(() => {
      task.finish()
    })
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

function isExternalUrl(url: string) {
  return urlRegex().test(url)
}

async function replaceCssUrls(
  text: string,
  parentUrl: string,
  replacer: (url: string) => string | Promise<string>
) {
  const editor = new MagicString(text)
  const loading: Promise<void>[] = []
  const cssUrlRE = /url\(\s*('[^']+'|"[^"]+"|[^'")]+)\s*\)/g
  for (;;) {
    const match = cssUrlRE.exec(text)
    if (!match) {
      await Promise.all(loading)
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
    if (isExternalUrl(url))
      loading.push(
        Promise.resolve(replacer(url)).then(url => {
          editor.overwrite(
            match.index + 4,
            match.index + match[0].length - 1,
            JSON.stringify(url)
          )
        })
      )
  }
}
