import { createRoot, hydrateRoot } from 'react-dom/client'
import { PublicSite } from './Root'
import { loadSite } from './api'
import type { SiteData } from './context'
export async function mountPublicSite() {
  const element = document.getElementById('root')!,
    bootstrap = document.getElementById('story2u-data')
  if (bootstrap?.textContent) {
    const data = JSON.parse(bootstrap.textContent) as SiteData
    hydrateRoot(element, <PublicSite data={data} />)
  } else {
    const data = await loadSite(new URL(location.href), '')
    createRoot(element).render(<PublicSite data={data} />)
  }
}
