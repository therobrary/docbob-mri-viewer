import {
  Enums as CoreEnums,
  RenderingEngine,
  getRenderingEngine,
  init as initializeCornerstoneCore,
  metaData,
  registerImageLoader,
  type Types,
  utilities,
} from '@cornerstonejs/core'
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader'
import {
  Enums as ToolEnums,
  PanTool,
  StackScrollTool,
  ToolGroupManager,
  WindowLevelTool,
  ZoomTool,
  addTool,
  init as initializeCornerstoneTools,
} from '@cornerstonejs/tools'

const RENDERING_ENGINE_ID = 'mri-viewer-rendering-engine'
const VIEWPORT_ID = 'mri-viewer-viewport'
const TOOL_GROUP_ID = 'mri-viewer-tool-group'

type ToolGroup = NonNullable<ReturnType<typeof ToolGroupManager.getToolGroup>>

export type ToolMode = 'windowLevel' | 'pan' | 'zoom'

export interface ViewerController {
  viewport: Types.IStackViewport
  renderingEngine: RenderingEngine
  toolGroup: ToolGroup
}

const toolModeToName: Record<ToolMode, string> = {
  windowLevel: WindowLevelTool.toolName,
  pan: PanTool.toolName,
  zoom: ZoomTool.toolName,
}

let initPromise: Promise<void> | null = null
let toolsRegistered = false
let dicomFileLoaderRegistered = false
type WadoDataSet = Parameters<typeof cornerstoneDICOMImageLoader.wadouri.getPixelData>[0]

const MAIN_THREAD_TRANSFER_SYNTAXES = new Set([
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.1',
  '1.2.840.10008.1.2.2',
])

async function initializeCornerstone(): Promise<void> {
  if (initPromise) {
    return initPromise
  }

  initPromise = (async () => {
    await initializeCornerstoneCore()
    cornerstoneDICOMImageLoader.init({
      maxWebWorkers:
        typeof navigator !== 'undefined' && navigator.hardwareConcurrency
          ? Math.max(1, Math.floor(navigator.hardwareConcurrency / 2))
          : 1,
    })
    initializeCornerstoneTools()

    if (!toolsRegistered) {
      addTool(WindowLevelTool)
      addTool(PanTool)
      addTool(ZoomTool)
      addTool(StackScrollTool)
      toolsRegistered = true
    }

    registerDicomFileLoader()
  })()

  return initPromise
}

function registerDicomFileLoader(): void {
  if (dicomFileLoaderRegistered) {
    return
  }

  const defaultLoader = cornerstoneDICOMImageLoader.wadouri.loadImage

  registerImageLoader('dicomfile', (imageId, options = {}) => {
    const parsedImageId = cornerstoneDICOMImageLoader.wadouri.parseImageId(imageId)
    const cachedDataSet = cornerstoneDICOMImageLoader.wadouri.dataSetCacheManager.isLoaded(parsedImageId.url)
      ? Promise.resolve(cornerstoneDICOMImageLoader.wadouri.dataSetCacheManager.get(parsedImageId.url))
      : cornerstoneDICOMImageLoader.wadouri.dataSetCacheManager.load(
          parsedImageId.url,
          cornerstoneDICOMImageLoader.wadouri.getLoaderForScheme(parsedImageId.scheme),
          imageId,
        )

    return {
      cancelFn: undefined,
      promise: cachedDataSet.then((dataSet) => {
        const transferSyntax = dataSet.string('x00020010')
        if (!transferSyntax || !MAIN_THREAD_TRANSFER_SYNTAXES.has(transferSyntax)) {
          return defaultLoader(imageId, options).promise
        }

        return buildUncompressedImage(dataSet, imageId, parsedImageId.pixelDataFrame ?? 0)
      }),
    }
  })

  dicomFileLoaderRegistered = true
}

async function buildUncompressedImage(
  dataSet: WadoDataSet,
  imageId: string,
  frameIndex: number,
): Promise<Types.IImage> {
  const imageFrame = cornerstoneDICOMImageLoader.getImageFrame(imageId)
  const pixelDataBytes = cornerstoneDICOMImageLoader.wadouri.getPixelData(dataSet, frameIndex)
  if (!pixelDataBytes?.length) {
    throw new Error('The pixel data is missing.')
  }

  const typedPixelData = decodeUncompressedPixelData(
    pixelDataBytes,
    imageFrame.bitsAllocated,
    imageFrame.pixelRepresentation,
    dataSet.string('x00020010') ?? '1.2.840.10008.1.2.1',
  )
  const minMax = cornerstoneDICOMImageLoader.getMinMax(typedPixelData)
  const imagePlaneModule = metaData.get('imagePlaneModule', imageId) ?? {}
  const voiLutModule = metaData.get('voiLutModule', imageId) ?? {}
  const modalityLutModule = metaData.get('modalityLutModule', imageId) ?? {}
  const calibrationModule = metaData.get('calibrationModule', imageId) ?? {}
  const defaultWindowLevel = utilities.windowLevel.toWindowLevel(minMax.min, minMax.max)

  imageFrame.pixelData = typedPixelData
  imageFrame.pixelDataLength = typedPixelData.length
  imageFrame.smallestPixelValue = minMax.min
  imageFrame.largestPixelValue = minMax.max
  const grayscaleCanvas = document.createElement('canvas')
  grayscaleCanvas.width = imageFrame.columns
  grayscaleCanvas.height = imageFrame.rows

  return {
    imageId,
    color: false,
    calibration: calibrationModule,
    columnPixelSpacing: imagePlaneModule.columnPixelSpacing,
    columns: imageFrame.columns,
    dataType: typedPixelData.constructor.name as Types.PixelDataTypedArrayString,
    decodeTimeInMS: undefined,
    getCanvas: () => grayscaleCanvas,
    getPixelData: () => typedPixelData,
    height: imageFrame.rows,
    imageFrame,
    intercept: modalityLutModule.rescaleIntercept ?? 0,
    invert: imageFrame.photometricInterpretation === 'MONOCHROME1',
    maxPixelValue: minMax.max,
    minPixelValue: minMax.min,
    numberOfComponents: 1,
    preScale: imageFrame.preScale,
    rgba: false,
    rowPixelSpacing: imagePlaneModule.rowPixelSpacing,
    rows: imageFrame.rows,
    sizeInBytes: typedPixelData.byteLength,
    slope: modalityLutModule.rescaleSlope ?? 1,
    voxelManager: undefined,
    voiLUTFunction: voiLutModule.voiLUTFunction?.[0],
    width: imageFrame.columns,
    windowCenter: voiLutModule.windowCenter?.[0] ?? defaultWindowLevel.windowCenter,
    windowWidth: voiLutModule.windowWidth?.[0] ?? defaultWindowLevel.windowWidth,
  }
}

function decodeUncompressedPixelData(
  pixelData: Uint8Array,
  bitsAllocated: number,
  pixelRepresentation: number,
  transferSyntax: string,
): Uint8Array | Uint16Array | Int16Array | Int8Array {
  if (bitsAllocated === 8) {
    const buffer = pixelData.buffer.slice(pixelData.byteOffset, pixelData.byteOffset + pixelData.byteLength)
    return pixelRepresentation === 1 ? new Int8Array(buffer) : new Uint8Array(buffer)
  }

  if (bitsAllocated !== 16) {
    throw new Error(`Unsupported uncompressed pixel format with bitsAllocated=${bitsAllocated}.`)
  }

  const buffer = pixelData.buffer.slice(pixelData.byteOffset, pixelData.byteOffset + pixelData.byteLength)
  const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2'
  const elementCount = pixelData.byteLength / 2

  if (littleEndian) {
    return pixelRepresentation === 1 ? new Int16Array(buffer) : new Uint16Array(buffer)
  }

  const view = new DataView(buffer)
  const typedArray = pixelRepresentation === 1 ? new Int16Array(elementCount) : new Uint16Array(elementCount)
  for (let index = 0; index < elementCount; index += 1) {
    typedArray[index] =
      pixelRepresentation === 1 ? view.getInt16(index * 2, false) : view.getUint16(index * 2, false)
  }

  return typedArray
}

function getOrCreateToolGroup(): ToolGroup {
  const existingToolGroup = ToolGroupManager.getToolGroup(TOOL_GROUP_ID)
  if (existingToolGroup) {
    return existingToolGroup
  }

  const createdToolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID)
  if (!createdToolGroup) {
    throw new Error('Unable to create the Cornerstone tool group.')
  }

  createdToolGroup.addTool(WindowLevelTool.toolName)
  createdToolGroup.addTool(PanTool.toolName)
  createdToolGroup.addTool(ZoomTool.toolName)
  createdToolGroup.addTool(StackScrollTool.toolName)
  createdToolGroup.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
  })

  setPrimaryTool(createdToolGroup, 'windowLevel')

  return createdToolGroup
}

export async function createViewer(element: HTMLDivElement): Promise<ViewerController> {
  await initializeCornerstone()

  const existingRenderingEngine = getRenderingEngine(RENDERING_ENGINE_ID)
  if (existingRenderingEngine) {
    existingRenderingEngine.destroy()
  }

  const renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID)
  renderingEngine.enableElement({
    viewportId: VIEWPORT_ID,
    type: CoreEnums.ViewportType.STACK,
    element,
    defaultOptions: {
      background: [0, 0, 0],
    },
  })

  const viewport = renderingEngine.getViewport(VIEWPORT_ID) as Types.IStackViewport
  const toolGroup = getOrCreateToolGroup()
  toolGroup.removeViewports(RENDERING_ENGINE_ID)
  toolGroup.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID)

  return {
    viewport,
    renderingEngine,
    toolGroup,
  }
}

export function setPrimaryTool(toolGroup: ToolGroup, toolMode: ToolMode): void {
  Object.values(toolModeToName).forEach((toolName) => {
    toolGroup.setToolPassive(toolName, { removeAllBindings: true })
  })

  toolGroup.setToolActive(toolModeToName[toolMode], {
    bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
  })
}

export function destroyViewer(): void {
  const renderingEngine = getRenderingEngine(RENDERING_ENGINE_ID)
  if (renderingEngine) {
    renderingEngine.destroy()
  }

  const toolGroup = ToolGroupManager.getToolGroup(TOOL_GROUP_ID)
  if (toolGroup) {
    toolGroup.removeViewports(RENDERING_ENGINE_ID)
  }
}
