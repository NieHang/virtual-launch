import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        buy: '#22c55e',
        sell: '#ef4444',
        accent: '#8b5cf6',
      },
    },
  },
  plugins: [],
}

export default config

