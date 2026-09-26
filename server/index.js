import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT ?? 3000)
const STATIC_DIR = path.join(__dirname, '..', 'dist')

const app = express()

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// Relays Grok calls to xAI. The browser can't call api.x.ai directly (no CORS),
// so requests pass through here. The user's key rides along on each request and
// is forwarded as-is — never stored or logged.
const XAI_ROUTES = new Set(['images/edits', 'images/generations', 'chat/completions'])

app.post('/api/xai/*', express.json({ limit: '40mb' }), async (req, res) => {
  const route = req.params[0]
  const key = req.get('x-xai-key')
  if (!XAI_ROUTES.has(route)) return res.status(404).json({ error: { message: 'Unknown xAI route.' } })
  if (!key) return res.status(400).json({ error: { message: 'Missing xAI API key.' } })

  try {
    const upstream = await fetch(`https://api.x.ai/v1/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(req.body),
      // Image edits can take a while; don't let a hung call hold the request forever.
      signal: AbortSignal.timeout(180_000),
    })
    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') ?? 'application/json')
      .send(Buffer.from(await upstream.arrayBuffer()))
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    res.status(502).json({
      error: {
        message: timedOut
          ? 'xAI took too long to respond. Try again.'
          : 'Could not reach api.x.ai from the server. Check the container has internet access.',
      },
    })
  }
})

// Serve the built frontend. Hashed assets can be cached hard; the shell cannot.
app.use(
  express.static(STATIC_DIR, {
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        res.setHeader('Cache-Control', 'no-cache')
      }
    },
  }),
)

app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Wrap Studio for Tesla listening on http://0.0.0.0:${PORT}`)
})
