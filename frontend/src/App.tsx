import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Enums as CornerstoneEnums } from '@cornerstonejs/core'
import './App.css'
import {
  createViewer,
  destroyViewer,
  setPrimaryTool,
  type ToolMode,
  type ViewerController,
} from './lib/cornerstone'
import { loadDicomStudy, type DicomSeries, type SkippedFile } from './lib/dicom'

const APP_TITLE = "Dr. Bob's MRI Viewer and Analyzer"
const DEFAULT_ANALYSIS_PROMPT =
  'Review these MRI images as a single study. When multiple rendered slices are provided, synthesize the full stack into one concise study-level response. Output exactly two short sections labeled "Summary:" and "Impression:". Use no more than four sentences total. Mention only the most important findings. If no obvious abnormality is visible, say that once plainly. Do not describe each slice separately, do not list every normal structure, and do not repeat negative findings.'
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')
const CINE_LOOP_FPS = 6
const CINE_LOOP_INTERVAL_MS = Math.round(1000 / CINE_LOOP_FPS)

type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type AnalysisState = 'idle' | 'running' | 'success' | 'error'
type AnalysisScope = 'slice' | 'stack'

interface BackendStatus {
  status: string
  mode: string
  ready: boolean
  model_id: string
  message: string | null
}

interface AnalysisResponse {
  analysis: string
  mode: string
  warnings: string[]
}

function App() {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const viewportElementRef = useRef<HTMLDivElement | null>(null)
  const viewerControllerRef = useRef<ViewerController | null>(null)
  const stackLoadRequestIdRef = useRef(0)

  const [seriesList, setSeriesList] = useState<DicomSeries[]>([])
  const [selectedSeriesUid, setSelectedSeriesUid] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [loadMessage, setLoadMessage] = useState('Upload a DICOM MRI series to begin.')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [viewerReady, setViewerReady] = useState(false)
  const [skippedFiles, setSkippedFiles] = useState<SkippedFile[]>([])
  const [activeTool, setActiveTool] = useState<ToolMode>('windowLevel')
  const [currentImageIndex, setCurrentImageIndex] = useState(0)
  const [voiSummary, setVoiSummary] = useState('Windowing will appear here after the first slice renders.')
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [analysisPrompt, setAnalysisPrompt] = useState(DEFAULT_ANALYSIS_PROMPT)
  const [analysisState, setAnalysisState] = useState<AnalysisState>('idle')
  const [analysisResult, setAnalysisResult] = useState<string>('')
  const [analysisWarnings, setAnalysisWarnings] = useState<string[]>([])
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [analysisStatusMessage, setAnalysisStatusMessage] = useState('')
  const [isCineLoopPlaying, setIsCineLoopPlaying] = useState(false)

  const selectedSeries = useMemo(
    () => seriesList.find((series) => series.seriesInstanceUid === selectedSeriesUid) ?? null,
    [seriesList, selectedSeriesUid],
  )
  const selectedInstance = selectedSeries?.instances[currentImageIndex] ?? null
  const isMultiSliceSeries = (selectedSeries?.instances.length ?? 0) > 1
  const canRunCineLoop =
    isMultiSliceSeries && loadState === 'ready' && analysisState !== 'running' && viewerReady

  useEffect(() => {
    document.title = APP_TITLE
  }, [])

  useEffect(() => {
    let isDisposed = false
    let cleanup: (() => void) | undefined

    async function bootstrapViewer(): Promise<void> {
      if (!viewportElementRef.current) {
        return
      }

      const viewportElement = viewportElementRef.current

      try {
        const controller = await createViewer(viewportElement)
        if (isDisposed) {
          return
        }

        viewerControllerRef.current = controller
        setViewerReady(true)

        const handleStackChange = (): void => {
          const nextIndex = controller.viewport.getCurrentImageIdIndex()
          const properties = controller.viewport.getProperties()
          setCurrentImageIndex(nextIndex)
          setVoiSummary(formatVoiSummary(properties.voiRange?.lower, properties.voiRange?.upper))
        }

        const handleResize = (): void => {
          controller.renderingEngine.resize(true, false)
        }

        viewportElement.addEventListener(CornerstoneEnums.Events.STACK_NEW_IMAGE, handleStackChange)
        viewportElement.addEventListener(CornerstoneEnums.Events.VOI_MODIFIED, handleStackChange)
        window.addEventListener('resize', handleResize)
        handleStackChange()

        cleanup = () => {
          window.removeEventListener('resize', handleResize)
          viewportElement.removeEventListener(CornerstoneEnums.Events.STACK_NEW_IMAGE, handleStackChange)
          viewportElement.removeEventListener(CornerstoneEnums.Events.VOI_MODIFIED, handleStackChange)
        }
      } catch (error) {
        if (error instanceof Error && !isDisposed) {
          setViewerReady(false)
          setLoadState('error')
          setLoadError(error.message)
        }
      }
    }

    void bootstrapViewer()

    return () => {
      isDisposed = true
      cleanup?.()
      viewerControllerRef.current = null
      destroyViewer()
    }
  }, [])

  useEffect(() => {
    const controller = viewerControllerRef.current
    if (!controller) {
      return
    }

    setPrimaryTool(controller.toolGroup, activeTool)
  }, [activeTool])

  useEffect(() => {
    if (!selectedSeries) {
      return
    }

    if (!viewerReady || !viewerControllerRef.current) {
      setLoadState('loading')
      setLoadError(null)
      return
    }

    let isCancelled = false
    let hasTimedOut = false
    const requestId = stackLoadRequestIdRef.current + 1
    stackLoadRequestIdRef.current = requestId
    const stackLoadTimeout = window.setTimeout(() => {
      hasTimedOut = true
      if (isCancelled || stackLoadRequestIdRef.current !== requestId) {
        return
      }

      setLoadState('error')
      setLoadError(
        `Timed out while rendering "${selectedSeries.label}". Try reloading the series or uploading the study again.`,
      )
    }, 60000)

    setLoadState('loading')
    setLoadError(null)
    setCurrentImageIndex(0)
    setIsCineLoopPlaying(false)

    viewerControllerRef.current.viewport
      .setStack(selectedSeries.imageIds, 0)
      .then(() => {
        window.clearTimeout(stackLoadTimeout)
        const controller = viewerControllerRef.current
        if (!controller || isCancelled || hasTimedOut || stackLoadRequestIdRef.current !== requestId) {
          return
        }

        controller.viewport.resetProperties()
        controller.viewport.resetCamera()
        controller.viewport.render()
        setLoadState('ready')
        setVoiSummary(formatViewportVoi(controller))
      })
      .catch((error: unknown) => {
        window.clearTimeout(stackLoadTimeout)
        if (isCancelled || hasTimedOut || stackLoadRequestIdRef.current !== requestId) {
          return
        }

        if (error instanceof Error) {
          setLoadState('error')
          setLoadError(error.message)
          return
        }

        throw error
      })

    return () => {
      isCancelled = true
      window.clearTimeout(stackLoadTimeout)
    }
  }, [selectedSeries, viewerReady])

  useEffect(() => {
    fetch(`${API_BASE_URL}/health`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Backend health check failed with ${response.status}`)
        }

        const payload = (await response.json()) as BackendStatus
        setBackendStatus(payload)
        setBackendError(null)
      })
      .catch((error: unknown) => {
        if (error instanceof Error) {
          setBackendError(error.message)
          return
        }

        throw error
      })
  }, [])

  useEffect(() => {
    if (canRunCineLoop || !isCineLoopPlaying) {
      return
    }

    setIsCineLoopPlaying(false)
  }, [canRunCineLoop, isCineLoopPlaying])

  async function handleFilesSelected(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const { files } = event.target
    if (!files || files.length === 0) {
      return
    }

    setAnalysisState('idle')
    setAnalysisResult('')
    setAnalysisWarnings([])
    setAnalysisError(null)
    setAnalysisStatusMessage('')
    setIsCineLoopPlaying(false)
    setLoadState('loading')
    setLoadError(null)
    setLoadMessage('Parsing DICOM files and grouping image slices into series...')

    try {
      const loadedStudy = await loadDicomStudy(Array.from(files))
      const preferredSeries = loadedStudy.seriesList.find((series) => series.modality === 'MR') ?? loadedStudy.seriesList[0]

      setSeriesList(loadedStudy.seriesList)
      setSelectedSeriesUid(preferredSeries?.seriesInstanceUid ?? null)
      setSkippedFiles(loadedStudy.skippedFiles)
      setLoadMessage(
        loadedStudy.skippedFiles.length > 0
          ? `Loaded ${loadedStudy.seriesList.length} series. Skipped ${loadedStudy.skippedFiles.length} non-image or invalid files.`
          : `Loaded ${loadedStudy.seriesList.length} series successfully.`,
      )
    } catch (error) {
      if (error instanceof Error) {
        setLoadState('error')
        setLoadError(error.message)
      }
    }
  }

  function openPicker(mode: 'files' | 'directory'): void {
    const input = uploadInputRef.current
    if (!input) {
      return
    }

    input.value = ''
    if (mode === 'directory') {
      input.setAttribute('webkitdirectory', '')
      input.setAttribute('directory', '')
    } else {
      input.removeAttribute('webkitdirectory')
      input.removeAttribute('directory')
    }

    input.click()
  }

  const jumpToImage = useCallback(
    async (index: number): Promise<void> => {
      const controller = viewerControllerRef.current
      if (!controller || !selectedSeries) {
        return
      }

      const boundedIndex = Math.min(Math.max(index, 0), selectedSeries.instances.length - 1)
      await controller.viewport.setImageIdIndex(boundedIndex)
      controller.viewport.render()
      setCurrentImageIndex(boundedIndex)
      setVoiSummary(formatViewportVoi(controller))
    },
    [selectedSeries],
  )

  useEffect(() => {
    if (!isCineLoopPlaying || !selectedSeries || !canRunCineLoop) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      const nextIndex = (currentImageIndex + 1) % selectedSeries.instances.length
      void jumpToImage(nextIndex)
    }, CINE_LOOP_INTERVAL_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [canRunCineLoop, currentImageIndex, isCineLoopPlaying, jumpToImage, selectedSeries])

  async function analyzeSeries(scope: AnalysisScope): Promise<void> {
    const controller = viewerControllerRef.current
    if (!controller || !selectedSeries) {
      return
    }

    if (loadState !== 'ready') {
      setAnalysisError('Wait for the selected series to finish rendering before starting analysis.')
      return
    }

    const startingImageIndex = currentImageIndex
    setIsCineLoopPlaying(false)
    setAnalysisState('running')
    setAnalysisResult('')
    setAnalysisError(null)
    setAnalysisWarnings([])
    setAnalysisStatusMessage(
      scope === 'stack'
        ? `Capturing ${selectedSeries.instances.length} rendered slices from the selected stack…`
        : 'Preparing the current slice for analysis…',
    )

    try {
      const imageDataUrls =
        scope === 'stack'
          ? await captureStackSnapshots(controller, selectedSeries.instances.length, setAnalysisStatusMessage)
          : [captureViewportSnapshot(controller.viewport.getCanvas())]

      setAnalysisStatusMessage(
        scope === 'stack'
          ? `Sending ${imageDataUrls.length} rendered slices to the model…`
          : 'Sending the current rendered slice to the model…',
      )

      const response = await fetch(`${API_BASE_URL}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image_data_url: imageDataUrls[0],
          image_data_urls: imageDataUrls,
          analysis_scope: scope,
          prompt: analysisPrompt,
          series_description: selectedSeries.label,
          modality: selectedSeries.modality,
          current_image_index: startingImageIndex,
          total_images: selectedSeries.instances.length,
        }),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { detail?: string }
        throw new Error(errorPayload.detail ?? `Analysis request failed with ${response.status}`)
      }

      const payload = (await response.json()) as AnalysisResponse
      setAnalysisResult(payload.analysis)
      setAnalysisWarnings(payload.warnings)
      setAnalysisState('success')
      setAnalysisStatusMessage(
        scope === 'stack'
          ? `Analyzed the full ${selectedSeries.instances.length}-slice stack.`
          : `Analyzed slice ${startingImageIndex + 1} of ${selectedSeries.instances.length}.`,
      )
    } catch (error) {
      if (error instanceof Error) {
        setAnalysisState('error')
        setAnalysisError(error.message)
        setAnalysisStatusMessage('')
      }
    }
  }

  function resetView(): void {
    const controller = viewerControllerRef.current
    if (!controller) {
      return
    }

    controller.viewport.resetProperties()
    controller.viewport.resetCamera()
    controller.viewport.render()
    setVoiSummary(formatViewportVoi(controller))
  }

  function toggleCineLoop(): void {
    if (!canRunCineLoop) {
      return
    }

    setIsCineLoopPlaying((current) => !current)
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <pre className="ascii-banner" aria-hidden="true">
            {`>==[ DR_BOB://MRI_VIEW ]==<
[ cine.loop ][ medgemma ][ ollama ]`}
          </pre>
          <p className="eyebrow">Dr. Bob&apos;s retro radiology console</p>
          <h1>{APP_TITLE}</h1>
          <p className="lede">
            Upload local DICOM files, run a continuous cine loop in-browser, and send either the current slice or
            the full rendered stack to Ollama-hosted MedGemma for one concise assistive MRI summary.
          </p>
        </div>

        <div className="upload-actions">
          <button type="button" onClick={() => openPicker('files')}>
            Upload files
          </button>
          <button type="button" className="secondary" onClick={() => openPicker('directory')}>
            Upload folder
          </button>
        </div>
      </header>

      <input ref={uploadInputRef} className="hidden-input" type="file" multiple onChange={handleFilesSelected} />

      <main className="app-grid">
        <aside className="sidebar card">
          <section>
            <h2>Series</h2>
            <p className="muted">{loadMessage}</p>
            {loadError ? <p className="error-text">{loadError}</p> : null}
            <div className="series-list">
              {seriesList.length === 0 ? <p className="muted">No series loaded yet.</p> : null}
              {seriesList.map((series) => (
                <button
                  key={series.seriesInstanceUid}
                  type="button"
                  className={series.seriesInstanceUid === selectedSeriesUid ? 'series-item active' : 'series-item'}
                  onClick={() => setSelectedSeriesUid(series.seriesInstanceUid)}
                >
                  <span>{series.label}</span>
                  <small>
                    {series.modality} • {series.instances.length} slices
                  </small>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2>Active slice</h2>
            {selectedInstance ? (
              <dl className="metadata-list">
                <div>
                  <dt>Patient</dt>
                  <dd>{selectedInstance.patientName}</dd>
                </div>
                <div>
                  <dt>Study</dt>
                  <dd>{selectedInstance.studyDescription}</dd>
                </div>
                <div>
                  <dt>Series</dt>
                  <dd>{selectedSeries?.label}</dd>
                </div>
                <div>
                  <dt>Slice</dt>
                  <dd>
                    {currentImageIndex + 1} / {selectedSeries?.instances.length}
                  </dd>
                </div>
                <div>
                  <dt>Dimensions</dt>
                  <dd>
                    {selectedInstance.columns ?? '?'} × {selectedInstance.rows ?? '?'}
                  </dd>
                </div>
                <div>
                  <dt>Slice thickness</dt>
                  <dd>{selectedInstance.sliceThickness ?? 'Unknown'}</dd>
                </div>
                <div>
                  <dt>Windowing</dt>
                  <dd>{voiSummary}</dd>
                </div>
              </dl>
            ) : (
              <p className="muted">Upload a study to inspect metadata.</p>
            )}
          </section>

          <section>
            <h2>Backend</h2>
            {backendStatus ? (
              <div className="backend-status">
                <p>
                  <strong>Mode:</strong> {backendStatus.mode}
                </p>
                <p>
                  <strong>Model:</strong> {backendStatus.model_id}
                </p>
                <p>
                  <strong>Ready:</strong> {backendStatus.ready ? 'Yes' : 'Not yet'}
                </p>
                {backendStatus.message ? <p className="muted">{backendStatus.message}</p> : null}
              </div>
            ) : (
              <p className="muted">Checking backend status…</p>
            )}
            {backendError ? <p className="error-text">{backendError}</p> : null}
          </section>
        </aside>

        <section className="viewer-panel card">
          <div className="viewer-toolbar">
            <div className="tool-buttons" role="toolbar" aria-label="Viewport tools">
              <button
                type="button"
                className={activeTool === 'windowLevel' ? 'tool-button active' : 'tool-button'}
                onClick={() => setActiveTool('windowLevel')}
              >
                Window/level
              </button>
              <button
                type="button"
                className={activeTool === 'pan' ? 'tool-button active' : 'tool-button'}
                onClick={() => setActiveTool('pan')}
              >
                Pan
              </button>
              <button
                type="button"
                className={activeTool === 'zoom' ? 'tool-button active' : 'tool-button'}
                onClick={() => setActiveTool('zoom')}
              >
                Zoom
              </button>
              <button type="button" className="tool-button secondary" onClick={resetView}>
                Reset view
              </button>
            </div>

            <div className="viewer-status">
              <span>
                {selectedSeries
                  ? `${selectedSeries.modality} series • ${selectedSeries.instances.length} slice${selectedSeries.instances.length === 1 ? '' : 's'}`
                  : 'No series loaded'}
              </span>
              <span>
                {loadState === 'loading'
                  ? 'Rendering slices…'
                  : isCineLoopPlaying
                    ? `Cine loop live @ ${CINE_LOOP_FPS} fps`
                    : 'Wheel, scrub, or start the cine loop'}
              </span>
            </div>
          </div>

          <div className="viewer-frame">
            <div ref={viewportElementRef} className="viewport" aria-label="MRI image viewport" />
            {!selectedSeries ? (
              <div className="viewer-empty-state">
                <p>Upload a DICOM MRI series to boot the viewer.</p>
              </div>
            ) : null}
          </div>

          <div className="slice-controls">
            <button
              type="button"
              className={isCineLoopPlaying ? 'tool-button active' : 'tool-button secondary'}
              onClick={toggleCineLoop}
              disabled={!canRunCineLoop}
            >
              {isCineLoopPlaying ? 'Pause cine loop' : `Start cine loop @ ${CINE_LOOP_FPS} fps`}
            </button>
            <span className="cine-readout">
              {isMultiSliceSeries ? 'Continuous wraparound playback enabled.' : 'Single-slice series loaded.'}
            </span>
            <button type="button" onClick={() => void jumpToImage(currentImageIndex - 1)} disabled={!selectedSeries}>
              Previous slice
            </button>
            <input
              type="range"
              min={0}
              max={Math.max((selectedSeries?.instances.length ?? 1) - 1, 0)}
              value={currentImageIndex}
              onChange={(event) => {
                void jumpToImage(Number(event.target.value))
              }}
              disabled={!selectedSeries}
            />
            <button type="button" onClick={() => void jumpToImage(currentImageIndex + 1)} disabled={!selectedSeries}>
              Next slice
            </button>
          </div>
        </section>

        <aside className="analysis-panel card">
          <section>
            <h2>MedGemma analysis console</h2>
            <p className="muted">
              The backend receives rendered slice snapshots from the current image or the selected stack, not the
              raw DICOM volume. Full-stack runs are prompted to return one concise study-level response rather than
              repetitive slice-by-slice commentary. Treat results as assistive output only.
            </p>
            <label className="prompt-label" htmlFor="analysis-prompt">
              MRI analysis prompt
            </label>
            <textarea
              id="analysis-prompt"
              rows={6}
              value={analysisPrompt}
              onChange={(event) => setAnalysisPrompt(event.target.value)}
            />
            <div className="analysis-actions">
              <button
                type="button"
                className="analyze-button"
                onClick={() => void analyzeSeries('slice')}
                disabled={!selectedSeries || analysisState === 'running' || loadState !== 'ready'}
              >
                {analysisState === 'running' ? 'Analyzing…' : 'Analyze current slice'}
              </button>
              <button
                type="button"
                className="analyze-button secondary"
                onClick={() => void analyzeSeries('stack')}
                disabled={!selectedSeries || analysisState === 'running' || loadState !== 'ready'}
              >
                {analysisState === 'running' ? 'Analyzing…' : 'Analyze full stack'}
              </button>
            </div>
            {analysisStatusMessage ? <p className="muted analysis-status">{analysisStatusMessage}</p> : null}
            {analysisError ? <p className="error-text">{analysisError}</p> : null}
            {analysisWarnings.length > 0 ? (
              <ul className="warning-list">
                {analysisWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <div className="analysis-result">
              {analysisResult ? (
                <p>{analysisResult}</p>
              ) : (
                <p className="muted">Run an analysis to see MedGemma output here.</p>
              )}
            </div>
          </section>

          <section>
              <h2>Validation notes</h2>
              <ul className="notes-list">
                <li>Optimized for local MRI uploads, continuous cine playback, and stack-level assistive analysis.</li>
                <li>Series grouping uses DICOM metadata such as Series Instance UID and Instance Number.</li>
                <li>Full-stack prompting is tuned for one concise MRI summary rather than per-slice narration.</li>
                <li>Invalid or non-image DICOM files are skipped and reported below.</li>
              </ul>
            {skippedFiles.length > 0 ? (
              <div className="skipped-files">
                <h3>Skipped files</h3>
                <ul>
                  {skippedFiles.slice(0, 8).map((skippedFile) => (
                    <li key={`${skippedFile.fileName}-${skippedFile.reason}`}>
                      <strong>{skippedFile.fileName}</strong>: {skippedFile.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </aside>
      </main>
    </div>
  )
}

function formatVoiSummary(lower?: number, upper?: number): string {
  if (lower === undefined || upper === undefined) {
    return 'Auto'
  }

  const windowWidth = Math.round(upper - lower)
  const windowCenter = Math.round((upper + lower) / 2)

  return `WW ${windowWidth} / WL ${windowCenter}`
}

function formatViewportVoi(controller: ViewerController): string {
  const properties = controller.viewport.getProperties()
  return formatVoiSummary(properties.voiRange?.lower, properties.voiRange?.upper)
}

async function captureStackSnapshots(
  controller: ViewerController,
  totalImages: number,
  setStatusMessage: (message: string) => void,
): Promise<string[]> {
  const originalImageIndex = controller.viewport.getCurrentImageIdIndex()
  const snapshots: string[] = []

  try {
    for (let index = 0; index < totalImages; index += 1) {
      setStatusMessage(`Capturing slice ${index + 1} of ${totalImages}…`)
      await controller.viewport.setImageIdIndex(index)
      controller.viewport.render()
      await waitForViewportPaint()
      snapshots.push(captureViewportSnapshot(controller.viewport.getCanvas()))
    }
  } finally {
    await controller.viewport.setImageIdIndex(originalImageIndex)
    controller.viewport.render()
    await waitForViewportPaint()
  }

  return snapshots
}

function captureViewportSnapshot(canvas: HTMLCanvasElement): string {
  if (canvas.width === 0 || canvas.height === 0) {
    throw new Error('The current slice has not rendered yet. Try again in a moment.')
  }

  const MAX_DIMENSION = 768
  const scale = Math.min(1, MAX_DIMENSION / Math.max(canvas.width, canvas.height))
  if (scale === 1) {
    return canvas.toDataURL('image/jpeg', 0.92)
  }

  const snapshotCanvas = document.createElement('canvas')
  snapshotCanvas.width = Math.max(1, Math.round(canvas.width * scale))
  snapshotCanvas.height = Math.max(1, Math.round(canvas.height * scale))
  const context = snapshotCanvas.getContext('2d')
  if (!context) {
    throw new Error('Unable to prepare the rendered slice for analysis.')
  }

  context.drawImage(canvas, 0, 0, snapshotCanvas.width, snapshotCanvas.height)
  return snapshotCanvas.toDataURL('image/jpeg', 0.92)
}

function waitForViewportPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

export default App
