import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Enums as CornerstoneEnums } from '@cornerstonejs/core'
import {
  createViewer,
  destroyViewer,
  setPrimaryTool,
  type ToolMode,
  type ViewerController,
} from '../lib/cornerstone'
import { loadDicomStudy, type DicomSeries, type SkippedFile } from '../lib/dicom'
import { API_BASE_URL, MRI_MODALITY, STACK_ANALYSIS_SNAPSHOT_LIMIT } from '../config/modalities'

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

interface MriWorkbenchProps {
  onNavigateHome: () => void
}

function MriWorkbench({ onNavigateHome }: MriWorkbenchProps) {
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
  const [analysisPrompt, setAnalysisPrompt] = useState(MRI_MODALITY.defaultPrompt ?? '')
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
    setLoadMessage('Parsing DICOM files and grouping image slices into MRI series...')

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
    const representativeSliceCount = getRepresentativeImageIndices(
      selectedSeries.instances.length,
      STACK_ANALYSIS_SNAPSHOT_LIMIT,
    ).length

    setIsCineLoopPlaying(false)
    setAnalysisState('running')
    setAnalysisResult('')
    setAnalysisError(null)
    setAnalysisWarnings([])
    setAnalysisStatusMessage(
      scope === 'stack'
        ? `Capturing ${describeStackSampling(representativeSliceCount, selectedSeries.instances.length)}…`
        : 'Preparing the current slice for analysis…',
    )

    try {
      const imageDataUrls =
        scope === 'stack'
          ? await captureStackSnapshots(controller, selectedSeries.instances.length, setAnalysisStatusMessage)
          : [captureViewportSnapshot(controller.viewport.getCanvas())]

      setAnalysisStatusMessage(
        scope === 'stack'
          ? `Sending ${describeStackSampling(imageDataUrls.length, selectedSeries.instances.length)} to the model…`
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
          ? `Analyzed ${describeStackSampling(imageDataUrls.length, selectedSeries.instances.length)}.`
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
          <div className="route-meta">
            <button type="button" className="secondary" onClick={onNavigateHome}>
              Back to landing page
            </button>
            <span className="status-chip available">MRI workspace</span>
          </div>
          <pre className="ascii-banner" aria-hidden="true">
            {`>==[ DOCBOB://MRI_VIEW ]==<
[ cine.loop ][ medgemma ][ gateway ]`}
          </pre>
          <p className="eyebrow">Assistive MRI interpretation console</p>
          <h1>{MRI_MODALITY.label}</h1>
          <p className="lede">
            Upload local DICOM files, run a continuous cine loop in-browser, and send either the current slice or a
            representative stack sample to the configured OpenAI-compatible gateway for one concise assistive MRI
            summary.
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
            <h2>Gateway</h2>
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
              <p className="muted">Checking gateway status…</p>
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
            <h2>AI interpretation console</h2>
            <p className="muted">
              The API receives rendered slice snapshots from the current image or the selected stack, not the raw DICOM
              volume. Large stack runs are sampled down to representative ordered slices before they are sent to the
              multimodal gateway. Treat results as assistive output only.
            </p>
            <label className="prompt-label" htmlFor="analysis-prompt">
              MRI interpretation prompt
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
                <p className="muted">Run an analysis to see the returned model output here.</p>
              )}
            </div>
          </section>

          <section>
            <h2>Validation notes</h2>
            <ul className="notes-list">
              <li>Optimized for local MRI uploads, continuous cine playback, and concise assistive stack analysis.</li>
              <li>Series grouping uses DICOM metadata such as Series Instance UID and Instance Number.</li>
              <li>Large stacks are sampled down to representative slices before upload to reduce gateway request size.</li>
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

function describeStackSampling(sampleCount: number, totalImages: number): string {
  if (sampleCount >= totalImages) {
    return `all ${totalImages} rendered slices from the selected stack`
  }

  return `${sampleCount} representative rendered slices sampled from the ${totalImages}-image stack`
}

async function captureStackSnapshots(
  controller: ViewerController,
  totalImages: number,
  setStatusMessage: (message: string) => void,
): Promise<string[]> {
  const originalImageIndex = controller.viewport.getCurrentImageIdIndex()
  const sampleIndices = getRepresentativeImageIndices(totalImages, STACK_ANALYSIS_SNAPSHOT_LIMIT)
  const snapshots: string[] = []

  try {
    for (const [samplePosition, imageIndex] of sampleIndices.entries()) {
      setStatusMessage(
        sampleIndices.length === totalImages
          ? `Capturing slice ${imageIndex + 1} of ${totalImages}…`
          : `Capturing representative slice ${samplePosition + 1} of ${sampleIndices.length} (source slice ${imageIndex + 1} of ${totalImages})…`,
      )
      await controller.viewport.setImageIdIndex(imageIndex)
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

function getRepresentativeImageIndices(totalImages: number, limit: number): number[] {
  if (totalImages <= 0) {
    return []
  }

  if (totalImages <= limit) {
    return Array.from({ length: totalImages }, (_, index) => index)
  }

  const desiredCount = Math.min(totalImages, Math.max(2, limit))
  const uniqueIndices = new Set<number>()

  for (let step = 0; step < desiredCount; step += 1) {
    const nextIndex = Math.round((step * (totalImages - 1)) / (desiredCount - 1))
    uniqueIndices.add(nextIndex)
  }

  if (uniqueIndices.size < desiredCount) {
    for (let index = 0; index < totalImages && uniqueIndices.size < desiredCount; index += 1) {
      uniqueIndices.add(index)
    }
  }

  return Array.from(uniqueIndices).sort((left, right) => left - right)
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

export default MriWorkbench
