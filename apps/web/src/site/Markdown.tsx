import ReactMarkdown from 'react-markdown'
export function Markdown({ markdown }: { markdown: string }) {
  return (
    <div className="site-markdown">
      <ReactMarkdown
        skipHtml
        components={{
          h1: ({ children }) => <h2>{children}</h2>,
          a: ({ href, children }) => (
            <a href={href} rel="noreferrer noopener">
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            src?.startsWith('https://') ? (
              <img
                src={src}
                alt={alt ?? ''}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : null,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
