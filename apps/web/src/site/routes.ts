export const publicPath = (path: string) =>
  path === '/' ||
  /^\/discover(?:\/(?:recent|categories|search))?$/.test(path) ||
  /^\/books\/[a-z0-9-]+(?:\/chapters\/[a-z0-9-]+)?$/.test(path) ||
  /^\/authors\/[a-z0-9-]+$/.test(path) ||
  [
    '/about',
    '/writers',
    '/policy/content',
    '/policy/privacy',
    '/contact',
  ].includes(path)

export const studioPath = (path: string) =>
  path === '/studio' || path === '/studio/publish'
