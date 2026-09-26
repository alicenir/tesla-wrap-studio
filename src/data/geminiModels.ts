export type FreeTier = 'yes' | 'no' | 'unknown'

export interface GeminiImageModel {
  id: string
  label: string
  description: string
  freeTier: FreeTier
  /** Shown when this model is selected, to set expectations before the first call. */
  note?: string
}

export interface GeminiTextModel {
  id: string
  label: string
  description: string
}

/**
 * Text models used by "AI Wrap Generation" to invent a concept.
 *
 * Kept as a user-visible list rather than a hardcoded constant: the previous
 * hardcoded gemini-2.5-flash started returning 404 "no longer available to new
 * users" when Google retired it, which silently broke the button. Selecting the
 * model also means the call runs on whatever account tier you've chosen instead
 * of a fixed default.
 */
export const GEMINI_TEXT_MODELS: GeminiTextModel[] = [
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    description: 'gemini-3.6-flash — current general-purpose Flash model',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    description: 'gemini-3.5-flash-lite — cheapest and fastest',
  },
]

/** Gemini image-generation models reachable via generateContent + responseModalities: ["IMAGE"]. */
export const GEMINI_IMAGE_MODELS: GeminiImageModel[] = [
  {
    id: 'gemini-2.5-flash-image',
    label: 'Nano Banana',
    description: 'gemini-2.5-flash-image — best default, low latency, lowest cost',
    freeTier: 'no',
  },
  {
    id: 'gemini-3-pro-image-preview',
    label: 'Nano Banana Pro',
    description: 'gemini-3-pro-image-preview — best detail, higher cost per image',
    freeTier: 'no',
  },
  {
    id: 'gemini-3.1-flash-image-preview',
    label: 'Nano Banana 2 (preview)',
    description: 'gemini-3.1-flash-image-preview — newer preview model',
    freeTier: 'no',
    note: 'Preview model — Google may change or retire it without notice.',
  },
]
