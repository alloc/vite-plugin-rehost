import type { Plugin } from 'vite'

type PluginConfig = {}

export default (config: PluginConfig = {}): Plugin => {
  return {
    name: 'vite:rehost',
  }
}
