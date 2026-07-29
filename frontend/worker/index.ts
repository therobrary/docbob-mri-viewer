type AnalysisScope = 'slice' | 'stack'

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>
  }
  MEDGEMMA_MODE?: string
  MEDGEMMA_MODEL_ID?: string
  AI_BASE_URL?: string
  AI_TIMEOUT_SECONDS?: string
  AI_MAX_TOKENS?: string
  AI_TEMPERATURE?: string
  AI_TOP_P?: string
  AI_AUTH_HEADER_NAME?: string
  AI_AUTH_HEADER_VALUE?: string
  OLLAMA_BASE_URL?: string
  OLLAMA_TIMEOUT_SECONDS?: string
  OLLAMA_NUM_PREDICT?: string
  OLLAMA_TEMPERATURE?: string
  OLLAMA_TOP_P?: string
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

interface GatewayErrorShape {
  message?: string
}

interface GatewayModelsResponse {
  data?: Array<{ id?: string }>
  error?: string | GatewayErrorShape
  message?: string
}

interface GatewayTextPart {
  type?: string
  text?: string
}

interface GatewayChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | GatewayTextPart[]
    }
  }>
  error?: string | GatewayErrorShape
  message?: string
}

interface GatewayRequestResult {
  status: number
  body: unknown
  text: string
}

const DEFAULT_MEDGEMMA_MODE = 'gateway'
const DEFAULT_MEDGEMMA_MODEL_ID = 'ollama-medgemma'
const DEFAULT_AI_BASE_URL = 'https://aigateway.r0b.cc/v1'
const DEFAULT_AI_TIMEOUT_SECONDS = 120
const DEFAULT_AI_MAX_TOKENS = 256
const DEFAULT_AI_TEMPERATURE = 0.1
const DEFAULT_AI_TOP_P = 0.8
const DEFAULT_AI_AUTH_HEADER_NAME = 'Authorization'

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
    const normalizedPath = normalizeApiPath(url.pathname)
    const origin = request.headers.get('Origin')
    const allowedOrigins = resolveAllowedOrigins(env)

    if (request.method === 'OPTIONS' && isApiPath(normalizedPath)) {
      // SECURITY (M2): preflight from a disallowed origin is 403 (no ACAO),
      // not 204. The browser never proceeds to the actual request.
      if (origin && !allowedOrigins.includes(origin)) {
        return new Response(null, { status: 403, headers: { 'Vary': 'Origin' } })
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) })
    }

    if (normalizedPath === '/health') {
      if (request.method !== 'GET') {
        return jsonResponse({ detail: 'Method not allowed.' }, 405, origin, allowedOrigins)
      }

      try {
        return jsonResponse(await health(env), 200, origin, allowedOrigins)
      } catch (error) {
        return handleUnexpectedError(error, origin, allowedOrigins)
      }
    }

    if (normalizedPath === '/analyze') {
      if (request.method !== 'POST') {
        return jsonResponse({ detail: 'Method not allowed.' }, 405, origin, allowedOrigins)
      }

      try {
        return jsonResponse(await analyze(request, env), 200, origin, allowedOrigins)
      } catch (error) {
        if (error instanceof MedGemmaConfigurationError) {
          return jsonResponse({ detail: error.message }, 503, origin, allowedOrigins)
        }
        if (error instanceof SyntaxError) {
          return jsonResponse({ detail: 'Request body must be valid JSON.' }, 400, origin, allowedOrigins)
        }
        if (error instanceof TypeError || error instanceof RangeError) {
          return jsonResponse({ detail: error.message }, 400, origin, allowedOrigins)
        }
        return handleUnexpectedError(error, origin, allowedOrigins)
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ detail: 'Not found.' }, 404, origin, allowedOrigins)
    }

    return env.ASSETS.fetch(request)
  },
}

async function health(env: Env): Promise<HealthResponse> {
  const mode = getMedgemmaMode(env)
  let ready = false
  let message: string | null = null

  try {
    ;[ready, message] = mode === 'mock' ? mockReadiness() : await gatewayReadiness(env)
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

  if (mode !== 'gateway') {
    throw new MedGemmaConfigurationError(`Unsupported MEDGEMMA_MODE: ${mode}. Use "mock" or "gateway".`)
  }

  const gatewayPayload = await requestGatewayJson<GatewayChatCompletionResponse>(env, '/chat/completions', {
    model: getModelId(env),
    max_tokens: getAiMaxTokens(env),
    temperature: getAiTemperature(env),
    top_p: getAiTopP(env),
    messages: [
      {
        role: 'system',
        content:
          'You are an assistive radiology imaging reviewer. Stay concise, non-diagnostic, and follow the requested response format exactly.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(payload) },
          ...getImageDataUrls(payload).map((imageDataUrl) => ({
            type: 'image_url',
            image_url: {
              url: validateImageDataUrl(imageDataUrl),
            },
          })),
        ],
      },
    ],
  })

  const analysis = extractCompletionText(gatewayPayload)
  const normalizedAnalysis = normalizeAnalysisOutput(analysis, payload.analysis_scope)
  const warnings = [
    'MedGemma output is assistive only and must not be treated as a diagnosis.',
    'This viewer sends rendered slice snapshots to the model, not the raw full-volume DICOM series.',
  ]

  if (
    payload.analysis_scope === 'stack' &&
    payload.total_images !== null &&
    payload.total_images !== undefined &&
    getImageDataUrls(payload).length < payload.total_images
  ) {
    warnings.push(
      `Stack analysis used ${getImageDataUrls(payload).length} representative rendered slice snapshots from ${payload.total_images} total images to keep the gateway request smaller.`,
    )
  }

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
    validateImageDataUrl(imageDataUrl)
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
      'Mock mode is active. Set MEDGEMMA_MODE=gateway to route requests to the configured AI gateway.',
      'Treat model output as assistive only; this project does not provide diagnostic validation.',
    ],
  }
}

function mockReadiness(): [boolean, string] {
  return [true, 'Mock mode is active for local development. No model endpoint calls are being made.']
}

async function gatewayReadiness(env: Env): Promise<[boolean, string | null]> {
  ensureGatewayConfiguration(env)

  const modelsResponse = await requestGateway(env, '/models', undefined, 'GET', [404, 405])
  const modelId = getModelId(env)

  if (modelsResponse.status === 404 || modelsResponse.status === 405) {
    return [
      true,
      `Connected to the AI gateway at ${getAiBaseUrl(env)}. The endpoint does not expose /models, so model validation will happen on analyze requests.`,
    ]
  }

  const body = modelsResponse.body as GatewayModelsResponse
  if (!Array.isArray(body.data)) {
    return [true, `Connected to the AI gateway at ${getAiBaseUrl(env)}, but /models returned an unexpected response.`]
  }

  const modelAvailable = body.data.some((model) => model && typeof model.id === 'string' && model.id === modelId)
  if (!modelAvailable) {
    return [false, `Connected to the AI gateway at ${getAiBaseUrl(env)}, but model "${modelId}" was not listed there.`]
  }

  return [true, `Connected to the AI gateway at ${getAiBaseUrl(env)} and found model "${modelId}".`]
}

async function requestGatewayJson<T>(
  env: Env,
  path: string,
  payload?: unknown,
  method: 'GET' | 'POST' = payload === undefined ? 'GET' : 'POST',
): Promise<T> {
  const result = await requestGateway(env, path, payload, method)
  if (!result.body || typeof result.body !== 'object') {
    throw new MedGemmaConfigurationError('The AI gateway returned a non-JSON response.')
  }
  return result.body as T
}

async function requestGateway(
  env: Env,
  path: string,
  payload?: unknown,
  method: 'GET' | 'POST' = payload === undefined ? 'GET' : 'POST',
  allowedErrorStatuses: number[] = [],
): Promise<GatewayRequestResult> {
  ensureGatewayConfiguration(env)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), getAiTimeoutSeconds(env) * 1000)

  try {
    const headers = new Headers({
      Accept: 'application/json',
      [getAiAuthHeaderName(env)]: getAiAuthHeaderValue(env),
    })

    if (payload !== undefined) {
      headers.set('Content-Type', 'application/json')
    }

    const response = await fetch(joinAiUrl(getAiBaseUrl(env), path), {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    })

    const responseText = await response.text()
    const parsedBody = parseResponseBody(responseText)

    if (!response.ok && !allowedErrorStatuses.includes(response.status)) {
      throw new MedGemmaConfigurationError(
        `AI gateway request to ${path} failed with ${response.status}: ${getGatewayErrorMessage(parsedBody, responseText, response.statusText)}`,
      )
    }

    return {
      status: response.status,
      body: parsedBody,
      text: responseText,
    }
  } catch (error) {
    if (error instanceof MedGemmaConfigurationError) {
      throw error
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MedGemmaConfigurationError(`AI gateway request to ${path} timed out after ${getAiTimeoutSeconds(env)} seconds.`)
    }
    if (error instanceof Error) {
      throw new MedGemmaConfigurationError(`Unable to reach the AI gateway at ${getAiBaseUrl(env)}: ${error.message}`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

function parseResponseBody(responseText: string): unknown {
  if (!responseText.trim()) {
    return {}
  }

  try {
    return JSON.parse(responseText) as unknown
  } catch {
    return responseText
  }
}

function extractCompletionText(payload: GatewayChatCompletionResponse): string {
  const content = payload.choices?.[0]?.message?.content

  if (typeof content === 'string' && content.trim()) {
    return content
  }

  if (Array.isArray(content)) {
    const textContent = content
      .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text.trim()] : []))
      .filter(Boolean)
      .join(' ')

    if (textContent) {
      return textContent
    }
  }

  throw new MedGemmaConfigurationError('The AI gateway returned an empty analysis response.')
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
    const stackDescriptor =
      imageCount < request.total_images
        ? `Analyze ${imageCount} representative rendered slice snapshots sampled in order from a series containing ${request.total_images} total images.`
        : `Analyze the full rendered stack of ${imageCount} slice snapshots from first to last within a series containing ${request.total_images} total images.`
    context.push(stackDescriptor)
    context.push('Synthesize the ordered images as one study-level review.')
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
    if (request.total_images !== null && request.total_images !== undefined && imageCount < request.total_images) {
      return `a representative stack sample of ${imageCount} slice snapshots from ${request.total_images} total images`
    }
    return `the full stack of ${imageCount} slice snapshots`
  }
  if (request.current_image_index !== null && request.current_image_index !== undefined && request.total_images) {
    return `slice ${request.current_image_index + 1} of ${request.total_images}`
  }
  return 'the current slice'
}

function validateImageDataUrl(imageDataUrl: string): string {
  const match = DATA_URL_PATTERN.exec(imageDataUrl)
  if (!match?.groups?.data) {
    throw new MedGemmaConfigurationError('The frontend must send a PNG or JPEG data URL for analysis.')
  }

  try {
    atob(match.groups.data)
  } catch {
    throw new MedGemmaConfigurationError('The frontend sent invalid base64 image data.')
  }

  return imageDataUrl
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

function normalizeApiPath(pathname: string): string {
  if (pathname === '/health' || pathname === '/analyze') {
    return pathname
  }

  if (pathname.startsWith('/api/')) {
    return pathname.slice(4)
  }

  return pathname
}

function isApiPath(pathname: string): boolean {
  return pathname === '/health' || pathname === '/analyze'
}

function ensureGatewayConfiguration(env: Env): void {
  if (!getAiBaseUrl(env).trim()) {
    throw new MedGemmaConfigurationError('AI_BASE_URL must be configured for gateway mode.')
  }
  if (!getModelId(env).trim()) {
    throw new MedGemmaConfigurationError('MEDGEMMA_MODEL_ID must be configured for gateway mode.')
  }
  if (!getAiAuthHeaderValue(env).trim()) {
    throw new MedGemmaConfigurationError(
      'AI_AUTH_HEADER_VALUE must be configured as a Worker secret before gateway requests can run.',
    )
  }
}

function getGatewayErrorMessage(body: unknown, responseText: string, fallback: string): string {
  if (typeof body === 'string' && body.trim()) {
    return body.trim()
  }

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim()
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error.trim()
    }
    if (record.error && typeof record.error === 'object') {
      const errorRecord = record.error as Record<string, unknown>
      if (typeof errorRecord.message === 'string' && errorRecord.message.trim()) {
        return errorRecord.message.trim()
      }
    }
  }

  return responseText.trim() || fallback
}

function getMedgemmaMode(env: Env): string {
  return env.MEDGEMMA_MODE ?? DEFAULT_MEDGEMMA_MODE
}

function getModelId(env: Env): string {
  return env.MEDGEMMA_MODEL_ID ?? DEFAULT_MEDGEMMA_MODEL_ID
}

function getAiBaseUrl(env: Env): string {
  return env.AI_BASE_URL ?? env.OLLAMA_BASE_URL ?? DEFAULT_AI_BASE_URL
}

function getAiTimeoutSeconds(env: Env): number {
  return getNumberSetting(env.AI_TIMEOUT_SECONDS ?? env.OLLAMA_TIMEOUT_SECONDS, DEFAULT_AI_TIMEOUT_SECONDS)
}

function getAiMaxTokens(env: Env): number {
  return getNumberSetting(env.AI_MAX_TOKENS ?? env.OLLAMA_NUM_PREDICT, DEFAULT_AI_MAX_TOKENS)
}

function getAiTemperature(env: Env): number {
  return getNumberSetting(env.AI_TEMPERATURE ?? env.OLLAMA_TEMPERATURE, DEFAULT_AI_TEMPERATURE)
}

function getAiTopP(env: Env): number {
  return getNumberSetting(env.AI_TOP_P ?? env.OLLAMA_TOP_P, DEFAULT_AI_TOP_P)
}

function getAiAuthHeaderName(env: Env): string {
  return env.AI_AUTH_HEADER_NAME ?? DEFAULT_AI_AUTH_HEADER_NAME
}

function getAiAuthHeaderValue(env: Env): string {
  return env.AI_AUTH_HEADER_VALUE ?? ''
}

function getNumberSetting(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function joinAiUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//u, ''), `${baseUrl.replace(/\/+$/u, '')}/`).toString()
}

function jsonResponse(body: unknown, status = 200, origin: string | null = null, allowedOrigins: readonly string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, allowedOrigins),
    },
  })
}

// SECURITY (M2): allowlist of origins permitted to call this API.
// Hardcoded safe defaults; the `ALLOWED_ORIGINS` worker secret (in
// wrangler.jsonc vars or via `wrangler secret put`) overrides at deploy
// time as a space-separated list.
const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'https://docbob.robrary.com',
  'https://docbob-dev.robrary.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
]

function resolveAllowedOrigins(env: Env): readonly string[] {
  const fromEnv = env && (env as unknown as { ALLOWED_ORIGINS?: unknown }).ALLOWED_ORIGINS
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim().split(/\s+/).filter(Boolean)
  }
  return DEFAULT_ALLOWED_ORIGINS
}

function corsHeaders(origin: string | null, allowedOrigins: readonly string[]): Record<string, string> {
  // SECURITY (M2): per-origin allowlist with Vary: Origin so caches don't
  // serve a poisoned ACAO to a different consumer. Disallowed origins get
  // NO ACAO header (browser will block), not a wildcard.
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
  if (origin && allowedOrigins.includes(origin)) {
    base['Access-Control-Allow-Origin'] = origin
  }
  return base
}

function handleUnexpectedError(error: unknown, origin: string | null = null, allowedOrigins: readonly string[] = []): Response {
  if (error instanceof Error) {
    return jsonResponse({ detail: error.message }, 500, origin, allowedOrigins)
  }
  return jsonResponse({ detail: 'Unexpected server error.' }, 500, origin, allowedOrigins)
}
