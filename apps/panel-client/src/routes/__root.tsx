import { QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import { BuildCompatibilityGate } from '../components/BuildCompatibilityGate'
import { PageSkeleton } from '../components/PageSkeleton'
import App, { NotFoundRoute } from '../App'
import { queryClient } from '../lib/queryClient'
import '../index.css'
import '../i18n'

export const Route = createRootRoute({
  component: StartDocument,
  notFoundComponent: NotFoundRoute,
  pendingComponent: () => (
    <PageSkeleton
      title="Loading"
      description="Opening panel route."
      eyebrow="// ROUTE"
      variant="default"
      metrics={['route']}
    />
  ),
})

function StartDocument() {
  const baseUrl = import.meta.env.BASE_URL

  return (
    <html lang="en" className="dark theme-survival" suppressHydrationWarning>
      <head>
        <meta charSet="UTF-8" />
        <link rel="icon" type="image/svg+xml" href={`${baseUrl}zombie.svg`} />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
          name="description"
          content="Admin control panel for Project Zomboid dedicated servers - manage players, mods, backups, and more"
        />
        <meta name="theme-color" content="#0a0c05" />
        <link
          rel="preload"
          href={`${baseUrl}fonts/bebas-neue-v16-latin.woff2`}
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <script dangerouslySetInnerHTML={{ __html: `
          (function () {
            try {
              var stored = localStorage.getItem('pz-panel-theme');
              var theme = (stored === 'light' || stored === 'survival') ? stored : 'survival';
              var root = document.documentElement;
              root.classList.remove('theme-survival', 'theme-light', 'dark');
              root.classList.add('theme-' + theme);
              if (theme === 'light') root.style.colorScheme = 'light';
              else { root.classList.add('dark'); root.style.colorScheme = 'dark'; }
            } catch (e) {}
          })();
        ` }} />
        <title>Zomboid Control Panel</title>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <BuildCompatibilityGate>
            <App />
          </BuildCompatibilityGate>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
