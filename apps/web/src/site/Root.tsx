import { emitGrowth, sourceBucket } from '../observability/growth'
import { useEffect } from 'react'
import Home from './Home'
import Discover from './Discover'
import { AuthorPage, BookDetail, StaticPage } from './Book'
import Reader from './Reader'
import { Container, EmptyState, Header, Footer } from './kit'
import { SiteContext, type SiteData } from './context'
import { prefs } from './store'
export function PublicSite({ data }: { data: SiteData }) {
  const theme = prefs.use()
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme.dark)
  }, [theme.dark])
  useEffect(() => {
    document.documentElement.dataset.siteHydrated = 'true'
    if (/^\/books\/[^/]+$/.test(data.path) && data.status === 200)
      emitGrowth('book_view', sourceBucket(document.referrer))
    return () => {
      delete document.documentElement.dataset.siteHydrated
    }
  }, [data.path, data.status])
  const parts = data.path.split('/').filter(Boolean)
  const page = data.error ? (
    <>
      <Header />
      <main>
        <Container>
          <EmptyState
            title={data.error}
            action={<a href={data.path}>重新加载</a>}
          />
        </Container>
      </main>
      <Footer />
    </>
  ) : parts.length === 0 ? (
    <Home />
  ) : parts[0] === 'discover' ? (
    <Discover mode={parts[1]} />
  ) : parts[0] === 'books' && parts[2] === 'chapters' ? (
    <Reader key={parts[3]} slug={parts[1]} no={parts[3]} />
  ) : parts[0] === 'books' ? (
    <BookDetail slug={parts[1]} />
  ) : parts[0] === 'authors' ? (
    <AuthorPage slug={parts[1]} />
  ) : (
    <StaticPage id={parts.join('/')} />
  )
  return (
    <SiteContext.Provider value={data}>
      <div
        className="min-h-full bg-page"
        onClick={(event) => {
          const anchor = (event.target as Element).closest('a[href]')
          const path = anchor?.getAttribute('href') ?? ''
          if (path === '/studio')
            emitGrowth('studio_entry', sourceBucket(document.referrer))
          if (/^\/books\/[^/]+\/chapters\/[^/]+$/.test(path)) {
            if (!data.path.includes('/chapters/'))
              emitGrowth('reading_started', sourceBucket(document.referrer))
            else if (anchor?.getAttribute('data-growth') === 'next_chapter')
              emitGrowth('next_chapter', sourceBucket(document.referrer))
          }
        }}
      >
        {page}
      </div>
    </SiteContext.Provider>
  )
}
