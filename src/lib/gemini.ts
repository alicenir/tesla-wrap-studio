import { GEMINI_IMAGE_MODELS } from '../data/geminiModels'

/**
 * A failure that will repeat for every request with the same key and model —
 * quota exhausted, key rejected, model retired — as opposed to one bad image.
 * Batch work stops on it instead of burning through the rest of the queue.
 */
export class AccountLevelError extends Error {}

export interface GeminiImageResult {
  dataUrl: string
  mimeType: string
}

export interface InputImage {
  base64: string
  mimeType: string
}

interface GenerateContentResponse {
  candidates?: Array<{
    finishReason?: string
    content?: {
      parts?: Array<{
        text?: string
        inlineData?: { mimeType: string; data: string }
      }>
    }
  }>
}

/**
 * Calls the Gemini generateContent REST endpoint asking for an IMAGE response.
 * When `inputImage` is provided (e.g. a Tesla wrap template), it's sent alongside
 * the text prompt so the model edits/fills that image rather than generating one
 * from scratch.
 *
 * Runs directly from the browser using a user-supplied API key (see ApiKeyInput) —
 * fine for personal/local use, but the key is visible in network requests made
 * from this page, so never deploy this build publicly with a key baked in.
 */
export async function generateWrapImage(
  apiKey: string,
  modelId: string,
  prompt: string,
  inputImages: InputImage[] = [],
  signal?: AbortSignal,
): Promise<GeminiImageResult> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ]
  for (const image of inputImages) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } })
  }

  const data = await callGenerateContent(apiKey, modelId, parts, ['IMAGE'], signal)

  const resultParts: Array<{ inlineData?: { mimeType: string; data: string } }> =
    data?.candidates?.[0]?.content?.parts ?? []
  const imagePart = resultParts.find((p) => p.inlineData?.data)
  if (!imagePart?.inlineData) {
    const finishReason = data?.candidates?.[0]?.finishReason
    throw new Error(
      `The model did not return an image${finishReason ? ` (finishReason: ${finishReason})` : ''}. Try a different description or model.`,
    )
  }

  return {
    dataUrl: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`,
    mimeType: imagePart.inlineData.mimeType,
  }
}

/** Asks a Gemini text model to invent a short creative wrap concept (used by "AI Wrap Generation"). */
export async function generateConceptText(
  apiKey: string,
  modelId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const data = await callGenerateContent(apiKey, modelId, [{ text: prompt }], ['TEXT'], signal)
  const resultParts: Array<{ text?: string }> = data?.candidates?.[0]?.content?.parts ?? []
  const text = resultParts.map((p) => p.text ?? '').join('').trim()
  if (!text) throw new Error('The model did not return a concept. Try again.')
  return text
}

async function callGenerateContent(
  apiKey: string,
  modelId: string,
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
  responseModalities: string[],
  signal?: AbortSignal,
): Promise<GenerateContentResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelId,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities },
    }),
  })

  if (!res.ok) {
    let detail = ''
    try {
      const errBody = await res.json()
      detail = errBody?.error?.message ?? JSON.stringify(errBody)
    } catch {
      detail = await res.text()
    }

    if (res.status === 429) {
      throw new AccountLevelError(explainQuotaError(modelId, detail))
    }
    if (res.status === 404 && /no longer available|not found|not supported/i.test(detail)) {
      throw new AccountLevelError(
        `Google has retired "${modelId}", so this request was rejected. Pick a different model in the dropdown at the top — if they're all failing, Google has moved on and the model list in src/data/geminiModels.ts needs updating.`,
      )
    }
    if (res.status === 400 && /api key/i.test(detail)) {
      throw new AccountLevelError('That API key was rejected. Check it was copied in full from aistudio.google.com/apikey.')
    }
    throw new Error(`Gemini API error (${res.status}): ${detail || res.statusText}`)
  }

  return res.json()
}

/**
 * Turns Google's raw 429 body into something actionable. Two very different
 * situations share this status code: a model with no free quota at all
 * (reported as "limit: 0"), and an ordinary rate limit that clears on its own.
 */
function explainQuotaError(modelId: string, detail: string): string {
  const model = GEMINI_IMAGE_MODELS.find((m) => m.id === modelId)
  const retrySeconds = /retry in ([\d.]+)s/i.exec(detail)?.[1]

  if (/limit: 0/.test(detail) || model?.freeTier === 'no') {
    const free = GEMINI_IMAGE_MODELS.find((m) => m.freeTier === 'yes')
    return [
      `${model?.label ?? modelId} has no quota on your account, so this request was rejected before it ran.`,
      free ? `Switch the Model dropdown to “${free.label}”, which does have a free quota.` : '',
      'Gemini image models require billing: enable it on the Google Cloud project that owns this API key, then try again.',
    ]
      .filter(Boolean)
      .join(' ')
  }

  const wait = retrySeconds ? ` Try again in about ${Math.ceil(Number(retrySeconds))} seconds.` : ''
  return `Rate limit reached for ${model?.label ?? modelId}.${wait} Free-tier quotas reset daily.`
}
