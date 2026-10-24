import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const config = defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'story2u-public-ssr',
    configureServer(server) {
      if(process.env.WRITER_AGENT_PUBLIC_SSR !== '1') return
      server.middlewares.use(async (req,res,next)=>{
        const path=req.url??'/'
        if(path.startsWith('/studio'))res.setHeader('X-Robots-Tag','noindex,nofollow')
        if(req.method!=='GET'||path.startsWith('/src/')||path.startsWith('/@')||path.startsWith('/node_modules/')||path.startsWith('/v1/')||path.startsWith('/studio')||(/\.(?:svg|png|css|js)$/.test(path)&&!path.startsWith('/og/books/')))return next()
        try {
          const {renderPublic}=await server.ssrLoadModule('/src/site/server.tsx')
          const {readFile}=await import('node:fs/promises')
          const template=await server.transformIndexHtml(path,await readFile(new URL('./index.html',import.meta.url),'utf8'))
          const response:Response|null=await renderPublic(new URL(path,'http://localhost'),process.env.WRITER_AGENT_API_TARGET??'http://127.0.0.1:8787',process.env.STORY2U_SITE_ORIGIN??'https://www.story2u.xyz',template)
          if(!response){res.statusCode=404;res.setHeader('X-Robots-Tag','noindex');res.end('页面不存在');return}
          res.statusCode=response.status;response.headers.forEach((v,k)=>res.setHeader(k,v));res.end(await response.text())
        }catch(error){server.ssrFixStacktrace(error as Error);res.statusCode=503;res.end('作品服务暂时无法连接。')}
      })
    },
  }],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/v1': {
        target: process.env.WRITER_AGENT_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
})

export default {
  ...config,
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/test/**/*.test.{ts,tsx}'],
    exclude: ['src/test/authWorker.test.ts'],
    css: true,
  },
}
