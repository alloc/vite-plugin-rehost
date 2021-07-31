import { Plugin, normalizePath } from 'vite'
import cheerio from 'cheerio'
import path from 'path'
import fs from 'fs'
import { createHash } from 'crypto'
import { AsyncFileCache } from './AsyncFileCache'
import { debug } from './debug'

export default (): Plugin => {
  let base: string
  let outDir: string
  let assetsDir: string
  let useEmitFile = true

  const emitCache = new Map<string, string>()
  const files = new AsyncFileCache(async id => {
    if (useEmitFile) {
      return id
    }
    const source = await files.get(id)
    const fileName = getFileName(id.slice(1), getAssetHash(source), assetsDir)
    emitCache.set(id, path.resolve(outDir, fileName))
    return base + fileName
  })

  return {
    name: 'vite:rehost',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      base = config.base
      outDir = path.resolve(config.root, config.build.outDir)
      assetsDir = normalizePath(config.build.assetsDir)
    },
    resolveId(id) {
      if (files.has(id)) {
        return id
      }
    },
    // Self-hosted files may be bundled.
    async load(id) {
      const source = await files.get(id)
      if (source) {
        debug(`bundling file: ${id}`)
        return source.toString()
      }
    },
    transformIndexHtml: {
      enforce: 'pre',
      async transform(html) {
        const $ = cheerio.load(html)

        $('link[rel="stylesheet"]').each((_i, el) => {
          files.fetchStyles($(el))
        })
        $('script[src]').each((_i, el) => {
          files.fetchScript($(el))
        })

        return $.html()
      },
    },
    async resolveBuiltUrl(id) {
      const source = await files.get(id)
      if (source == null) {
        return null
      }
      if (useEmitFile) {
        const assetId = emitCache.get(id)
        if (assetId) {
          return assetId
        }
      }
      const fileName = getFileName(id.slice(1), getAssetHash(source), assetsDir)
      if (useEmitFile) {
        debug(`emitting file: ${fileName}`)
        let assetId = this.emitFile({
          type: 'asset',
          fileName,
          source,
        })
        // Vite replaces __VITE_ASSET__ imports in its default plugins
        emitCache.set(id, (assetId = `__VITE_ASSET__${assetId}__`))
        return assetId
      }
      emitCache.set(id, path.resolve(outDir, fileName))
      return base + fileName
    },
    async generateBundle() {
      if (useEmitFile)
        await Promise.all(
          files.unusedAssets.map(async id => {
            const source = await files.get(id)
            const fileName = getFileName(
              id.slice(1),
              getAssetHash(source),
              assetsDir
            )
            debug(`emitting file: ${fileName}`)
            this.emitFile({
              type: 'asset',
              fileName,
              source,
            })
          })
        )
    },
    writeBundle() {
      // No files have been emitted yet? That means we need
      // to write files manually in the `closeBundle` phase.
      if (!emitCache.size) {
        useEmitFile = false
      }
    },
    async closeBundle() {
      if (useEmitFile) {
        // Ensure `emitFile` is called on rebuilds.
        emitCache.clear()
      } else {
        const loadedFiles = await files.entries()
        for (const [id, source] of loadedFiles) {
          const filePath = emitCache.get(id)
          if (filePath) {
            debug('writing file:', filePath)
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, source)
          } else {
            debug('skipping file:', id)
          }
        }
      }
    },
  }
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
