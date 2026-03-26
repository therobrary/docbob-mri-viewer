type AnalysisScope = 'slice' | 'stack'

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>
  }
  MEDGEMMA_MODE?: string
  MEDGEMMA_MODEL_ID?: string
  OLLAMA_BASE_URL?: string
  OLLAMA_TIMEOUT_SECONDS?: string
  OLLAMA_NUM_PREDICT?: string
  OLLAMA_TEMPERATURE?: string
  OLLAMA_TOP_P?: string
  OLLAMA_REPEAT_PENALTY?: string
}

interface AnalyzeRequest {
  image_data_url?: string | null
  image_data_urls?: string[]
  analysis_scope?: AnalysisScope
  prompt: string
  series_description?: string | null
  modality?: string | null
  current_image_index?: number | null
  total_images?: number | null
}

interface AnalyzeResponse {
  analysis: string
  mode: string
  warnings: string[]
}

interface HealthResponse {
  status: string
  mode: string
  ready: boolean
  model_id: string
  message: string | null
}

interface OllamaTagsResponse {
  models?: Array<Record<string, unknown>>
  error?: string
}

interface OllamaShowResponse {
  details?: unknown
  model_info?: unknown
  modelfile?: unknown
  template?: unknown
  error?: string
}

interface OllamaGenerateResponse {
  response?: string
  error?: string
}

const DEFAULT_MEDGEMMA_MODE = 'ollama'
const DEFAULT_MEDGEMMA_MODEL_ID = 'dcarrascosa/medgemma-1.5-4b-it:Q8_0'
const DEFAULT_OLLAMA_BASE_URL = 'http://192.168.8.150:11434'
const DEFAULT_OLLAMA_TIMEOUT_SECONDS = 120
const DEFAULT_OLLAMA_NUM_PREDICT = 128
const DEFAULT_OLLAMA_TEMPERATURE = 0.1
const DEFAULT_OLLAMA_TOP_P = 0.75
const DEFAULT_OLLAMA_REPEAT_PENALTY = 1.24

const DATA_URL_PATTERN = /^data:(?<mime>[-\w.+/]+);base64,(?<data>.+)$/u
const SENTENCE_SPLIT_PATTERN = /(?<=[.!?])\s+/u
const WHITESPACE_PATTERN = /\s+/gu

class MedGemmaConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MedGemmaConfigurationError'
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS' && (url.pathname === '/health' || url.pathname === '/analyze')) {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    if (url.pathname === '/health') {
      if (request.method !== 'GET') {
        return jsonResponse({ detail: 'Method not allowed.' }, 405)
      }

      try {
        return jsonResponse(await health(env))
      } catch (error) {
        return handleUnexpectedError(error)
      }
    }

    if (url.pathname === '/analyze') {
      if (request.method !== 'POST') {
        return jsonResponse({ detail: 'Method not allowed.' }, 405)
      }

      try {
        return jsonResponse(await analyze(request, env))
      } catch (error) {
        if (error instanceof MedGemmaConfigurationError) {
          return jsonResponse({ detail: error.message }, 503)
        }
        if (error instanceof SyntaxError) {
          return jsonResponse({ detail: 'Request body must be valid JSON.' }, 400)
        }
        if (error instanceof TypeError || error instanceof RangeError) {
          return jsonResponse({ detail: error.message }, 400)
        }
        return handleUnexpectedError(error)
      }
    }

    return env.ASSETS.fetch(request)
  },
}

async function health(env: Env): Promise<HealthResponse> {
  const mode = getMedgemmaMode(env)
  let ready = false
  let message: string | null = null

  try {
    ;[ready, message] = mode === 'mock' ? mockReadiness() : await ollamaReadiness(env)
  } catch (error) {
    if (error instanceof MedGemmaConfigurationError) {
      ready = false
      message = error.message
    } else {
      throw error
    }
  }

  return {
    status: 'ok',
    mode,
    ready,
    model_id: getModelId(env),
    message,
  }
}

async function analyze(request: Request, env: Env): Promise<AnalyzeResponse> {
  const payload = validateAnalyzeRequest((await request.json()) as unknown)
  const mode = getMedgemmaMode(env)

  if (mode === 'mock') {
    return mockAnalyze(payload)
  }

  if (mode !== 'ollama') {
    throw new MedGemmaConfigurationError(`Unsupported MEDGEMMA_MODE: ${mode}. Use "mock" or "ollama".`)
  }

  const ollamaPayload = (await requestOllamaJson<OllamaGenerateResponse>(
    env,
    '/api/generate',
    {
      model: getModelId(env),
      prompt: buildPrompt(payload),
      images: getImageDataUrls(payload).map(extractImageBase64),
      stream: false,
      options: {
        num_predict: getNumberSetting(env.OLLAMA_NUM_PREDICT, DEFAULT_OLLAMA_NUM_PREDICT),
        temperature: getNumberSetting(env.OLLAMA_TEMPERATURE, DEFAULT_OLLAMA_TEMPERATURE),
        top_p: getNumberSetting(env.OLLAMA_TOP_P, DEFAULT_OLLAMA_TOP_P),
        repeat_penalty: getNumberSetting(env.OLLAMA_REPEAT_PENALTY, DEFAULT_OLLAMA_REPEAT_PENALTY),
      },
    },
  )) as OllamaGenerateResponse

  const analysis = ollamaPayload.response
  if (typeof analysis !== 'string' || !analysis.trim()) {
    throw new MedGemmaConfigurationError('Ollama returned an empty analysis response.')
  }

  const normalizedAnalysis = normalizeAnalysisOutput(analysis, payload.analysis_scope)
  const warnings = [
    'MedGemma output is assistive only and must not be treated as a diagnosis.',
    'This viewer sends rendered slice snapshots to the model, not the raw full-volume DICOM series.',
  ]

  if (normalizedAnalysis !== analysis.trim()) {
    warnings.push('The backend shortened repetitive model output to keep the response concise.')
  }

  return {
    analysis: normalizedAnalysis,
    mode,
    warnings,
  }
}

function mockAnalyze(request: AnalyzeRequest): AnalyzeResponse {
  const imageCount = getImageDataUrls(request).length
  for (const imageDataUrl of getImageDataUrls(request)) {
    extractImageBase64(imageDataUrl)
  }

  const seriesContext = request.series_description ?? 'uploaded series'
  const sliceContext = describeAnalysisScope(request, imageCount)
  return {
    analysis:
      'Mock MedGemma mode is enabled, so this response is a placeholder rather than a real model run. ' +
      `The backend received ${imageCount} rendered image snapshot(s) from ${seriesContext} and ${sliceContext}. ` +
      `Your prompt was: ${request.prompt}`,
    mode: 'mock',
    warnings: [
      'Mock mode is active. Set MEDGEMMA_MODE=ollama to route requests to the configured Ollama server.',
      'Treat model output as assistive only; this project does not provide diagnostic validation.',
    ],
  }
}

function mockReadiness(): [boolean, string] {
  return [true, 'Mock mode is active for local development. No model endpoint calls are being made.']
}

async function ollamaReadiness(env: Env): Promise<[boolean, string | null]> {
  const tagsPayload = await requestOllamaJson<OllamaTagsResponse>(env, '/api/tags')
  const models = tagsPayload.models
  if (!Array.isArray(models)) {
    return [false, 'Connected to Ollama, but the server returned an unexpected model list response.']
  }

  const modelId = getModelId(env)
  const modelAvailable = models.some((model) => {
    if (!model || typeof model !== 'object') {
      return false
    }
    return model.model === modelId || model.name === modelId
  })

  if (!modelAvailable) {
    return [false, `Connected to Ollama at ${getOllamaBaseUrl(env)}, but model "${modelId}" is not available there.`]
  }

  const modelDetails = await requestOllamaJson<OllamaShowResponse>(env, '/api/show', { model: modelId })
  if (!supportsImageInput(modelDetails)) {
    return [
      false,
      `Connected to Ollama at ${getOllamaBaseUrl(env)} and found model "${modelId}", but its metadata does not indicate image-input support. Image analysis requests will fail until the server exposes a multimodal build of this model.`,
    ]
  }

  return [true, `Connected to Ollama at ${getOllamaBaseUrl(env)} and found model "${modelId}".`]
}

async function requestOllamaJson<T>(env: Env, path: string, payload?: unknown): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), getNumberSetting(env.OLLAMA_TIMEOUT_SECONDS, DEFAULT_OLLAMA_TIMEOUT_SECONDS) * 1000)

  try {
    const response = await fetch(joinOllamaUrl(getOllamaBaseUrl(env), path), {
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    })

    const responseText = await response.text()
    const body = responseText ? (JSON.parse(responseText) as T & { error?: unknown }) : ({} as T & { error?: unknown })

    if (!response.ok) {
      const detail =
        body && typeof body === 'object' && typeof body.error === 'string'
          ? body.error
          : responseText.trim() || `${response.status} ${response.statusText}`
      throw new MedGemmaConfigurationError(`Ollama request to ${path} failed with ${response.status}: ${detail}`)
    }

    if (!body || typeof body !== 'object') {
      throw new MedGemmaConfigurationError('Ollama returned a non-JSON response.')
    }

    if (typeof body.error === 'string' && body.error) {
      throw new MedGemmaConfigurationError(body.error)
    }

    return body
  } catch (error) {
    if (error instanceof MedGemmaConfigurationError) {
      throw error
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MedGemmaConfigurationError(
        `Ollama request to ${path} timed out after ${getNumberSetting(env.OLLAMA_TIMEOUT_SECONDS, DEFAULT_OLLAMA_TIMEOUT_SECONDS)} seconds.`,
      )
    }
    if (error instanceof Error) {
      throw new MedGemmaConfigurationError(`Unable to reach Ollama at ${getOllamaBaseUrl(env)}: ${error.message}`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

function validateAnalyzeRequest(value: unknown): AnalyzeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Request body must be a JSON object.')
  }

  const record = value as Record<string, unknown>
  const prompt = record.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 4000) {
    throw new TypeError('Prompt is required and must be between 1 and 4000 characters.')
  }

  const imageDataUrl = normalizeOptionalString(record.image_data_url, 'image_data_url')
  const imageDataUrls = normalizeStringArray(record.image_data_urls, 'image_data_urls')
  if (imageDataUrl === null && imageDataUrls.length === 0) {
    throw new TypeError('At least one rendered image data URL is required for analysis.')
  }

  const analysisScope = record.analysis_scope
  if (analysisScope !== undefined && analysisScope !== 'slice' && analysisScope !== 'stack') {
    throw new TypeError('analysis_scope must be "slice" or "stack".')
  }

  return {
    image_data_url: imageDataUrl,
    image_data_urls: imageDataUrls,
    analysis_scope: analysisScope ?? 'slice',
    prompt,
    series_description: normalizeOptionalString(record.series_description, 'series_description', 512),
    modality: normalizeOptionalString(record.modality, 'modality', 64),
    current_image_index: normalizeOptionalInteger(record.current_image_index, 'current_image_index', 0),
    total_images: normalizeOptionalInteger(record.total_images, 'total_images', 1),
  }
}

function normalizeOptionalString(value: unknown, fieldName: string, maxLength?: number): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string when provided.`)
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new RangeError(`${fieldName} must be at most ${maxLength} characters.`)
  }
  return value
}

function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${fieldName} must be an array of strings when provided.`)
  }
  return value
}

function normalizeOptionalInteger(value: unknown, fieldName: string, minimum: number): number | null {
  if (value === undefined || value === null) {
    return null
  }
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new RangeError(`${fieldName} must be an integer greater than or equal to ${minimum}.`)
  }
  return value as number
}

function buildPrompt(request: AnalyzeRequest): string {
  const context: string[] = []

  if (request.series_description) {
    context.push(`Series: ${request.series_description}.`)
  }
  if (request.modality) {
    context.push(`Modality: ${request.modality}.`)
  }

  const imageCount = getImageDataUrls(request).length
  if (request.analysis_scope === 'stack' && request.total_images !== null && request.total_images !== undefined) {
    context.push(
      `Analyze the full rendered stack of ${imageCount} slice snapshots from first to last within a series containing ${request.total_images} total images.`,
    )
    context.push('Synthesize the entire ordered stack as one study-level review.')
    context.push('Return exactly two short sections labeled "Summary:" and "Impression:".')
    context.push('Use no more than four sentences total.')
    context.push('Mention only the most important overall findings across the stack.')
    context.push('If there is no obvious abnormality, say that plainly once instead of listing many normal structures.')
    context.push('Do not enumerate slices, do not repeat the same finding across images, and do not provide per-slice commentary.')
    context.push('Do not produce exhaustive normal checklists or repeated negative statements.')
  } else if (
    request.current_image_index !== null &&
    request.current_image_index !== undefined &&
    request.total_images !== null &&
    request.total_images !== undefined
  ) {
    context.push(`Current slice index: ${request.current_image_index + 1} of ${request.total_images}.`)
    context.push('Return exactly two short sections labeled "Summary:" and "Impression:".')
    context.push('Use no more than three sentences total.')
    context.push('Do not produce exhaustive normal checklists or repeated negative statements.')
  }

  context.push(
    'Focus on visible anatomy, intensity patterns, artifacts, and obvious abnormalities while remaining assistive and non-diagnostic.',
  )
  context.push(`User prompt: ${request.prompt}`)

  return context.join(' ')
}

function getImageDataUrls(request: AnalyzeRequest): string[] {
  if (request.image_data_urls && request.image_data_urls.length > 0) {
    return request.image_data_urls
  }
  if (request.image_data_url) {
    return [request.image_data_url]
  }
  return []
}

function describeAnalysisScope(request: AnalyzeRequest, imageCount: number): string {
  if (request.analysis_scope === 'stack') {
    return `the full stack of ${imageCount} slice snapshots`
  }
  if (request.current_image_index !== null && request.current_image_index !== undefined && request.total_images) {
    return `slice ${request.current_image_index + 1} of ${request.total_images}`
  }
  return 'the current slice'
}

function extractImageBase64(imageDataUrl: string): string {
  const match = DATA_URL_PATTERN.exec(imageDataUrl)
  if (!match?.groups?.data) {
    throw new MedGemmaConfigurationError('The frontend must send a PNG or JPEG data URL for analysis.')
  }

  try {
    atob(match.groups.data)
  } catch {
    throw new MedGemmaConfigurationError('The frontend sent invalid base64 image data.')
  }

  return match.groups.data
}

function normalizeAnalysisOutput(text: string, analysisScope: AnalysisScope = 'slice'): string {
  const compactText = text.replace(WHITESPACE_PATTERN, ' ').trim()
  if (!compactText) {
    return ''
  }

  const maxSentences = analysisScope === 'stack' ? 4 : 3
  const maxCharacters = analysisScope === 'stack' ? 480 : 360
  const uniqueSentences: string[] = []
  const seenSentences = new Set<string>()

  for (const sentence of compactText.split(SENTENCE_SPLIT_PATTERN)) {
    const cleanedSentence = sentence.trim()
    if (!cleanedSentence) {
      continue
    }

    const normalizedSentence = normalizeSentence(cleanedSentence)
    if (seenSentences.has(normalizedSentence)) {
      continue
    }

    seenSentences.add(normalizedSentence)
    uniqueSentences.push(cleanedSentence)
    if (uniqueSentences.length >= maxSentences) {
      break
    }
  }

  if (uniqueSentences.length === 0) {
    uniqueSentences.push(compactText)
  }

  const normalizedText = uniqueSentences.join(' ')
  if (normalizedText.length <= maxCharacters) {
    return normalizedText
  }

  const truncatedText = normalizedText.slice(0, maxCharacters).replace(/\s+\S*$/u, '').replace(/[,:; ]+$/u, '')
  if (truncatedText && !/[.!?]$/u.test(truncatedText)) {
    return `${truncatedText}…`
  }
  return truncatedText
}

function normalizeSentence(sentence: string): string {
  return sentence.replace(WHITESPACE_PATTERN, ' ').trim().toLowerCase().replace(/[.!?…]+$/u, '')
}

function supportsImageInput(modelDetails: OllamaShowResponse): boolean {
  const metadataBlob = JSON.stringify(
    {
      details: modelDetails.details,
      model_info: modelDetails.model_info,
      modelfile: modelDetails.modelfile,
      template: modelDetails.template,
    },
    null,
    0,
  ).toLowerCase()

  return ['image', 'vision', 'projector', 'mmproj', 'clip'].some((keyword) => metadataBlob.includes(keyword))
}

function getMedgemmaMode(env: Env): string {
  return env.MEDGEMMA_MODE ?? DEFAULT_MEDGEMMA_MODE
}

function getModelId(env: Env): string {
  return env.MEDGEMMA_MODEL_ID ?? DEFAULT_MEDGEMMA_MODEL_ID
}

function getOllamaBaseUrl(env: Env): string {
  return env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL
}

function getNumberSetting(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function joinOllamaUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//u, ''), `${baseUrl.replace(/\/+$/u, '')}/`).toString()
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function handleUnexpectedError(error: unknown): Response {
  if (error instanceof Error) {
    return jsonResponse({ detail: error.message }, 500)
  }
  return jsonResponse({ detail: 'Unexpected server error.' }, 500)
}
