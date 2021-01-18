import rehost from 'vite-plugin-rehost'
import reactPlugin from '@vitejs/plugin-react-refresh'
import type { UserConfig } from 'vite'

const config: UserConfig = {
  plugins: [
    reactPlugin(),
    rehost(),
  ],
}

export default config
