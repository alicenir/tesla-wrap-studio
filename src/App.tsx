import { useEffect, useRef, useState } from 'react'
import { ApiKeyInput } from './components/ApiKeyInput'
import { ModelSelector } from './components/ModelSelector'
import { ColorPicker } from './components/ColorPicker'
import { PromptComposer } from './components/PromptComposer'
import { WrapPreview } from './components/WrapPreview'
import { PortPanel } from './components/PortPanel'
import { ConceptDialog } from './components/ConceptDialog'
import { TESLA_MODELS } from './data/models'
import { TESLA_COLORS } from './data/colors'
import { type WrapIntensity } from './data/themes'
import { GEMINI_IMAGE_MODELS, GEMINI_TEXT_MODELS } from './data/geminiModels'
import { GROK_IMAGE_MODELS, GROK_TEXT_MODELS } from './data/grokModels'
import { VIEW_ANGLES } from './data/viewAngles'
import { TEXT_PLACEMENTS, type TextPlacementId } from './data/textPlacements'
import { DEFAULT_BRIEF, briefToPrompt, type BriefAnswers } from './data/conceptBrief'
import { buildWrapPrompt, buildConceptPrompt, buildMockupPrompt, buildPortPrompt } from './lib/promptBuilder'
import { flattenOnColor, splitDataUrl } from './lib/mockup'
import { AccountLevelError } from './lib/gemini'
import { aspectRatioFor } from './lib/grok'
import { activeKey, generateImage, generateConcept, type Provider } from './lib/imageProvider'
import { buildZip, dataUrlToBytes } from './lib/zip'
import { normalizeToWrapSpec, buildWrapFilename } from './lib/imageSpec'
import { fetchImageAsset, type FetchedImage } from './lib/templateAssets'
import { maskToPanels, findHoodPanel, rotateHoodInSource, type HoodPanel } from './lib/panelMask'
import type { WrapGenerationState, MockupState, HoodRotation, PortedWrap } from './types'

const LS_KEY = 'tesla-wrap-studio:v2'

const EMPTY_MOCKUP: MockupState = { open: false, active: 0, views: {} }

const BLANK_PANEL_CORRECTION =
  'RETRY — your previous attempt left an entire panel white and unpainted, most likely the large hood panel near the top centre. Paint over EVERY part of the image this time, especially that large top-centre panel, and keep the focal subject on it facing the TOP EDGE of the image. No region of the output may be white, blank or unpainted.'

interface PersistedPrefs {
  provider: Provider
  apiKey: string
  geminiModelId: string
  geminiTextModelId: string
  xaiKey: string
  grokModelId: string
  grokTextModelId: string
  modelId: string
  colorId: string
  customHex: string
  customName: string
  description: string
  intensity: WrapIntensity
  customText: string
  customTextPlacement: TextPlacementId
}

function loadPrefs(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const stored: PersistedPrefs = { ...defaultPrefs(), ...JSON.parse(raw) }
      // A model saved earlier may since have been retired by Google — fall back
      // rather than leaving the user stuck on an id that only 404s.
      if (!GEMINI_IMAGE_MODELS.some((m) => m.id === stored.geminiModelId)) {
        stored.geminiModelId = GEMINI_IMAGE_MODELS[0].id
      }
      if (!GEMINI_TEXT_MODELS.some((m) => m.id === stored.geminiTextModelId)) {
        stored.geminiTextModelId = GEMINI_TEXT_MODELS[0].id
      }
      if (!GROK_IMAGE_MODELS.some((m) => m.id === stored.grokModelId)) {
        stored.grokModelId = GROK_IMAGE_MODELS[0].id
      }
      if (!GROK_TEXT_MODELS.some((m) => m.id === stored.grokTextModelId)) {
        stored.grokTextModelId = GROK_TEXT_MODELS[0].id
      }
      return stored
    }
  } catch {
    // ignore corrupt storage
  }
  return defaultPrefs()
}

function defaultPrefs(): PersistedPrefs {
  return {
    provider: 'gemini',
    apiKey: '',
    geminiModelId: GEMINI_IMAGE_MODELS[0].id,
    geminiTextModelId: GEMINI_TEXT_MODELS[0].id,
    xaiKey: '',
    grokModelId: GROK_IMAGE_MODELS[0].id,
    grokTextModelId: GROK_TEXT_MODELS[0].id,
    modelId: TESLA_MODELS[0].id,
    colorId: TESLA_COLORS[0].id,
    customHex: '#8A8D90',
    customName: 'Custom color',
    description: '',
    intensity: 'balanced',
    customText: '',
    customTextPlacement: 'doors',
  }
}

export default function App() {
  const [prefs, setPrefs] = useState<PersistedPrefs>(loadPrefs)
  const [generation, setGeneration] = useState<WrapGenerationState>({ status: 'idle' })
  const [templateUrl, setTemplateUrl] = useState<string | null>(null)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [mockup, setMockup] = useState<MockupState>(EMPTY_MOCKUP)
  const [hoodRotation, setHoodRotation] = useState<HoodRotation>(0)
  const [ports, setPorts] = useState<Record<string, PortedWrap>>({})
  const [portAll, setPortAll] = useState<{ done: number; total: number } | null>(null)
  const [briefOpen, setBriefOpen] = useState(false)
  const [brief, setBrief] = useState<BriefAnswers>(DEFAULT_BRIEF)

  const templateCache = useRef<Map<string, FetchedImage>>(new Map())
  const hoodCache = useRef<Map<string, HoodPanel | null>>(new Map())
  const vehicleCache = useRef<Map<string, FetchedImage>>(new Map())
  // Bumped whenever the source wrap is replaced, so in-flight ports of the old
  // design are dropped instead of landing next to the new one.
  const portEpoch = useRef(0)
  const portAllStop = useRef(false)

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs))
  }, [prefs])

  const model = TESLA_MODELS.find((m) => m.id === prefs.modelId)!
  const selectedColor = TESLA_COLORS.find((c) => c.id === prefs.colorId)!
  const colorHex = prefs.colorId === 'custom' ? prefs.customHex : selectedColor.hex
  const colorName = prefs.colorId === 'custom' ? prefs.customName || 'Custom color' : selectedColor.name

  // Load (and cache) the official template whenever the selected model changes.
  useEffect(() => {
    let cancelled = false
    setTemplateError(null)

    const cached = templateCache.current.get(model.id)
    if (cached) {
      setTemplateUrl(cached.objectUrl)
      return
    }

    setTemplateUrl(null)
    fetchImageAsset(model.templateUrl)
      .then((img) => {
        if (cancelled) return
        templateCache.current.set(model.id, img)
        setTemplateUrl(img.objectUrl)
      })
      .catch((err) => {
        if (cancelled) return
        setTemplateError(err instanceof Error ? err.message : 'Could not load the template.')
      })

    return () => {
      cancelled = true
    }
  }, [model.id, model.templateUrl])

  const canGenerate = activeKey(prefs).length > 0 && Boolean(templateUrl) && !templateError
  const hasDescription = prefs.description.trim().length > 0

  async function generateAndMask(prompt: string, template: FetchedImage) {
    const raw = await generateImage(
      prefs,
      prompt,
      [{ base64: template.base64, mimeType: template.mimeType }],
      aspectRatioFor(template.width, template.height),
    )
    // Clip to the template's real panels so nothing can land on the glass roof or
    // the background, whatever the model actually drew.
    const masked = await maskToPanels(raw.dataUrl, template.objectUrl)
    // Keep the unmasked output — rotating the hood samples from it.
    return { ...masked, sourceDataUrl: raw.dataUrl }
  }

  async function runImageGeneration(description: string) {
    const template = templateCache.current.get(model.id)
    if (!template) {
      setGeneration({ status: 'error', error: 'Template is still loading — try again in a moment.' })
      return
    }

    // Any existing mockup or ported copy belongs to the previous wrap.
    setMockup(EMPTY_MOCKUP)
    setPorts({})
    portEpoch.current++
    portAllStop.current = true
    setGeneration({ status: 'loading-image' })
    try {
      const basePrompt = buildWrapPrompt({
        model,
        colorHex,
        colorName,
        description,
        intensity: prefs.intensity,
        customText: prefs.customText,
        customTextPlacement: TEXT_PLACEMENTS.find((p) => p.id === prefs.customTextPlacement)?.prompt,
      })

      // The model intermittently leaves a whole panel — usually the hood — unpainted.
      // Detect that after masking and retry once with a pointed correction rather
      // than handing back a wrap with a white frunk.
      let masked = await generateAndMask(basePrompt, template)
      if (masked.blankPanels > 0) {
        masked = await generateAndMask(`${basePrompt} ${BLANK_PANEL_CORRECTION}`, template)
      }

      const normalized = await normalizeToWrapSpec(masked.dataUrl, template.width, template.height)
      setHoodRotation(0)

      setGeneration({
        status: 'done',
        dataUrl: normalized.dataUrl,
        baseDataUrl: masked.dataUrl,
        sourceDataUrl: masked.sourceDataUrl,
        width: normalized.width,
        height: normalized.height,
        sizeBytes: normalized.sizeBytes,
      })
    } catch (err) {
      setGeneration({ status: 'error', error: err instanceof Error ? err.message : 'Generation failed.' })
    }
  }

  async function handleGenerate() {
    if (!hasDescription) return
    await runImageGeneration(prefs.description.trim())
  }

  async function handleAiWrapGeneration() {
    setBriefOpen(true)
  }

  async function runConceptGeneration() {
    setBriefOpen(false)
    setGeneration({ status: 'loading-concept' })
    try {
      const conceptPrompt = buildConceptPrompt({
        model,
        colorName,
        themeHint: prefs.description.trim() || undefined,
        brief: briefToPrompt(brief),
      })
      const concept = await generateConcept(prefs, conceptPrompt)
      setPrefs((p) => ({ ...p, description: concept }))
      await runImageGeneration(concept)
    } catch (err) {
      setGeneration({ status: 'error', error: err instanceof Error ? err.message : 'Concept generation failed.' })
    }
  }

  /** Hood geometry depends only on the template, so derive it once per model. */
  async function getHoodPanel(template: FetchedImage): Promise<HoodPanel | null> {
    const cached = hoodCache.current.get(model.id)
    if (cached !== undefined) return cached
    const hood = await findHoodPanel(template.objectUrl).catch(() => null)
    hoodCache.current.set(model.id, hood)
    return hood
  }

  async function handleHoodRotation(degrees: HoodRotation) {
    const template = templateCache.current.get(model.id)
    if (!template || !generation.baseDataUrl || !generation.sourceDataUrl) return

    setHoodRotation(degrees)
    try {
      const hood = await getHoodPanel(template)
      // Always re-derive from the unrotated source so repeated clicks don't compound,
      // and re-mask afterwards so the rotated wrap gets the same clipping and
      // blank-panel refill as a freshly generated one.
      let rotated = generation.baseDataUrl
      if (hood && degrees !== 0) {
        const rotatedSource = await rotateHoodInSource(generation.sourceDataUrl, hood, degrees)
        rotated = (await maskToPanels(rotatedSource, template.objectUrl)).dataUrl
      }
      const normalized = await normalizeToWrapSpec(rotated, template.width, template.height)
      setGeneration((g) => ({
        ...g,
        dataUrl: normalized.dataUrl,
        width: normalized.width,
        height: normalized.height,
        sizeBytes: normalized.sizeBytes,
      }))
      setMockup(EMPTY_MOCKUP)
    } catch (err) {
      setGeneration((g) => ({
        ...g,
        error: err instanceof Error ? err.message : 'Could not rotate the frunk artwork.',
      }))
    }
  }

  /** Renders one turntable angle. Cached angles are reused, so only new ones cost a call. */
  async function renderAngle(index: number) {
    if (!generation.dataUrl) return
    if (mockup.views[index]?.status === 'done') {
      setMockup((m) => ({ ...m, open: true, active: index }))
      return
    }

    setMockup((m) => ({ ...m, open: true, active: index, views: { ...m.views, [index]: { status: 'loading' } } }))
    try {
      // Show the unwrapped areas in the car's real paint colour rather than as
      // transparency, which the model would otherwise render as holes.
      const flattened = await flattenOnColor(generation.dataUrl, colorHex)
      const { base64, mimeType } = splitDataUrl(flattened)

      // Tesla ships a render of each exact variant. Passing it as a reference is
      // far more reliable than naming the model in text — "Model Y" alone doesn't
      // distinguish the pre-2025 car from the 2025 refresh, which look nothing alike.
      let vehicle = vehicleCache.current.get(model.id)
      if (!vehicle) {
        vehicle = await fetchImageAsset(model.vehicleImageUrl)
        vehicleCache.current.set(model.id, vehicle)
      }

      const result = await generateImage(
        prefs,
        buildMockupPrompt({ model, colorName, anglePrompt: VIEW_ANGLES[index].prompt }),
        // Vehicle reference first: the leading image anchors what is being drawn,
        // and burying it behind the wrap let the model default to a more familiar
        // generation of the same nameplate.
        [
          { base64: vehicle.base64, mimeType: vehicle.mimeType },
          { base64, mimeType },
        ],
      )
      setMockup((m) => ({ ...m, views: { ...m.views, [index]: { status: 'done', dataUrl: result.dataUrl } } }))
    } catch (err) {
      setMockup((m) => ({
        ...m,
        views: {
          ...m.views,
          [index]: { status: 'error', error: err instanceof Error ? err.message : 'Could not render the preview.' },
        },
      }))
    }
  }

  function handlePreviewOnCar() {
    void renderAngle(mockup.open ? mockup.active : 0)
  }

  /** Steps around the car; +1 walks right, -1 walks left. */
  function handleRotateView(step: number) {
    const next = (mockup.active + step + VIEW_ANGLES.length) % VIEW_ANGLES.length
    void renderAngle(next)
  }

  /**
   * Redraws the current wrap onto another vehicle's template. Records the outcome
   * in `ports` and rethrows, so batch callers can react to the failure.
   */
  async function portToModel(targetId: string) {
    const target = TESLA_MODELS.find((m) => m.id === targetId)
    if (!target || !generation.dataUrl) return
    const epoch = portEpoch.current
    const update = (port: PortedWrap) => {
      if (epoch === portEpoch.current) setPorts((p) => ({ ...p, [targetId]: port }))
    }

    update({ status: 'loading' })
    try {
      let template = templateCache.current.get(target.id)
      if (!template) {
        template = await fetchImageAsset(target.templateUrl)
        templateCache.current.set(target.id, template)
      }

      // Show unwrapped areas as paint rather than transparency, so the model reads
      // the source as a finished design rather than one full of holes.
      const flattened = await flattenOnColor(generation.dataUrl, colorHex)
      const source = splitDataUrl(flattened)

      const raw = await generateImage(
        prefs,
        buildPortPrompt({ target, colorHex, colorName }),
        [
          { base64: source.base64, mimeType: source.mimeType },
          { base64: template.base64, mimeType: template.mimeType },
        ],
        aspectRatioFor(template.width, template.height),
      )
      const masked = await maskToPanels(raw.dataUrl, template.objectUrl)
      const normalized = await normalizeToWrapSpec(masked.dataUrl, template.width, template.height)

      update({
        status: 'done',
        dataUrl: normalized.dataUrl,
        width: normalized.width,
        height: normalized.height,
        sizeBytes: normalized.sizeBytes,
      })
    } catch (err) {
      update({ status: 'error', error: err instanceof Error ? err.message : 'Could not port the design.' })
      throw err
    }
  }

  function handlePortToModel(targetId: string) {
    portToModel(targetId).catch(() => {
      // Already shown on that model's card.
    })
  }

  /**
   * Ports the design to every other vehicle, one at a time — parallel calls would
   * just trip the per-minute rate limit. Models already done are skipped, so this
   * also resumes after a stop or a quota error.
   */
  async function handlePortToAll() {
    const epoch = portEpoch.current
    const queue = TESLA_MODELS.filter((m) => m.id !== model.id && ports[m.id]?.status !== 'done')
    if (queue.length === 0) return

    portAllStop.current = false
    setPortAll({ done: 0, total: queue.length })
    for (const [i, target] of queue.entries()) {
      if (portAllStop.current || epoch !== portEpoch.current) break
      try {
        await portToModel(target.id)
      } catch (err) {
        // Quota, key and retired-model errors would fail every remaining model too.
        if (err instanceof AccountLevelError) break
      }
      setPortAll({ done: i + 1, total: queue.length })
    }
    if (epoch === portEpoch.current) setPortAll(null)
  }

  function handleStopPortAll() {
    portAllStop.current = true
  }

  function handleDownloadAll() {
    if (!generation.dataUrl) return
    const description = prefs.description || 'wrap'
    const entries = [{ model, dataUrl: generation.dataUrl }]
    for (const m of TESLA_MODELS) {
      const dataUrl = ports[m.id]?.status === 'done' ? ports[m.id].dataUrl : undefined
      if (dataUrl && m.id !== model.id) entries.push({ model: m, dataUrl })
    }

    const zip = buildZip(
      entries.map(({ model: m, dataUrl }) => ({
        // One folder per vehicle — the filenames alone don't say which car each fits.
        name: `${m.name}${m.subtitle ? ` - ${m.subtitle}` : ''}/${buildWrapFilename(description)}.png`.replace(
          /[\\:*?"<>|]/g,
          '',
        ),
        data: dataUrlToBytes(dataUrl),
      })),
    )
    const url = URL.createObjectURL(zip)
    const a = document.createElement('a')
    a.href = url
    a.download = `${buildWrapFilename(`${description} all models`)}.zip`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  function handlePortDownload(targetId: string) {
    const port = ports[targetId]
    const target = TESLA_MODELS.find((m) => m.id === targetId)
    if (!port?.dataUrl || !target) return
    const a = document.createElement('a')
    a.href = port.dataUrl
    a.download = `${buildWrapFilename(`${target.name} ${prefs.description || 'wrap'}`)}.png`
    a.click()
  }

  function handleDownload() {
    if (!generation.dataUrl) return
    const a = document.createElement('a')
    a.href = generation.dataUrl
    a.download = `${buildWrapFilename(prefs.description || `${model.name} wrap`)}.png`
    a.click()
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Wrap Studio for Tesla</h1>
        <p>
          Design AI-generated custom wraps using the real{' '}
          <a href="https://github.com/teslamotors/custom-wraps" target="_blank" rel="noreferrer">
            teslamotors/custom-wraps
          </a>{' '}
          templates.
        </p>
      </header>

      <main className="app-main">
        <ApiKeyInput
          settings={prefs}
          onChange={(patch) => setPrefs((p) => ({ ...p, ...patch }))}
        />

        <ModelSelector selectedId={prefs.modelId} onSelect={(modelId) => setPrefs((p) => ({ ...p, modelId }))} />

        <ColorPicker
          selectedId={prefs.colorId}
          customHex={prefs.customHex}
          customName={prefs.customName}
          onSelect={(colorId) => setPrefs((p) => ({ ...p, colorId }))}
          onCustomHexChange={(customHex) => setPrefs((p) => ({ ...p, customHex }))}
          onCustomNameChange={(customName) => setPrefs((p) => ({ ...p, customName }))}
        />

        <PromptComposer
          description={prefs.description}
          intensity={prefs.intensity}
          customText={prefs.customText}
          customTextPlacement={prefs.customTextPlacement}
          onDescriptionChange={(description) => setPrefs((p) => ({ ...p, description }))}
          onIntensityChange={(intensity) => setPrefs((p) => ({ ...p, intensity }))}
          onCustomTextChange={(customText) => setPrefs((p) => ({ ...p, customText }))}
          onCustomTextPlacementChange={(customTextPlacement) => setPrefs((p) => ({ ...p, customTextPlacement }))}
        />

        {templateError && <p className="hint error-text">{templateError}</p>}

        <WrapPreview
          model={model}
          templateUrl={templateUrl}
          state={generation}
          canGenerate={canGenerate}
          hasDescription={hasDescription}
          onGenerate={handleGenerate}
          onAiWrapGeneration={handleAiWrapGeneration}
          onDownload={handleDownload}
          mockup={mockup}
          onPreviewOnCar={handlePreviewOnCar}
          onRotateView={handleRotateView}
          hoodRotation={hoodRotation}
          onHoodRotation={handleHoodRotation}
        />

        {generation.status === 'done' && (
          <PortPanel
            sourceModel={model}
            ports={ports}
            busy={Object.values(ports).some((p) => p.status === 'loading')}
            portAll={portAll}
            onPort={handlePortToModel}
            onPortAll={handlePortToAll}
            onStopPortAll={handleStopPortAll}
            onDownload={handlePortDownload}
            onDownloadAll={handleDownloadAll}
          />
        )}

        {!canGenerate && !templateError && (
          <p className="hint center">Add your API key above to enable generation.</p>
        )}
      </main>

      {briefOpen && (
        <ConceptDialog
          answers={brief}
          existingPrompt={prefs.description}
          onChange={setBrief}
          onCancel={() => setBriefOpen(false)}
          onGenerate={() => void runConceptGeneration()}
        />
      )}

      <footer className="app-footer">
        <p>
          Templates and vehicle images are fetched live from{' '}
          <a href="https://github.com/teslamotors/custom-wraps" target="_blank" rel="noreferrer">
            teslamotors/custom-wraps
          </a>
          . Wrap specs (512–1024px, PNG, ≤1MB) follow the same repo. This project is not affiliated with or endorsed
          by Tesla, Inc.
        </p>
      </footer>
    </div>
  )
}
