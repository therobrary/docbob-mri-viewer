import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader'
import * as dicomParser from 'dicom-parser'

const SERIES_INSTANCE_UID_TAG = 'x0020000e'
const STUDY_INSTANCE_UID_TAG = 'x0020000d'
const SOP_INSTANCE_UID_TAG = 'x00080018'
const SERIES_DESCRIPTION_TAG = 'x0008103e'
const STUDY_DESCRIPTION_TAG = 'x00081030'
const PATIENT_NAME_TAG = 'x00100010'
const MODALITY_TAG = 'x00080060'
const INSTANCE_NUMBER_TAG = 'x00200013'
const IMAGE_POSITION_PATIENT_TAG = 'x00200032'
const SLICE_LOCATION_TAG = 'x00201041'
const ROWS_TAG = 'x00280010'
const COLUMNS_TAG = 'x00280011'
const NUMBER_OF_FRAMES_TAG = 'x00280008'
const SLICE_THICKNESS_TAG = 'x00180050'
const WINDOW_CENTER_TAG = 'x00281050'
const WINDOW_WIDTH_TAG = 'x00281051'
const PIXEL_DATA_TAG = 'x7fe00010'

export interface SkippedFile {
  fileName: string
  reason: string
}

export interface DicomInstance {
  imageId: string
  fileName: string
  frameNumber: number | null
  patientName: string
  studyInstanceUid: string
  studyDescription: string
  seriesInstanceUid: string
  seriesDescription: string
  sopInstanceUid: string
  modality: string
  instanceNumber: number | null
  imagePositionPatient: number[] | null
  sliceLocation: number | null
  rows: number | null
  columns: number | null
  sliceThickness: number | null
  windowCenter: number | null
  windowWidth: number | null
}

export interface DicomSeries {
  seriesInstanceUid: string
  label: string
  studyDescription: string
  patientName: string
  modality: string
  imageIds: string[]
  instances: DicomInstance[]
}

interface LoadedFile {
  type: 'loaded'
  instances: DicomInstance[]
}

interface SkippedLoadedFile {
  type: 'skipped'
  skippedFile: SkippedFile
}

type LoadedFileResult = LoadedFile | SkippedLoadedFile

export interface LoadedDicomStudy {
  seriesList: DicomSeries[]
  skippedFiles: SkippedFile[]
}

export async function loadDicomStudy(files: File[]): Promise<LoadedDicomStudy> {
  const loadedFiles = await Promise.all(files.map((file) => loadDicomFile(file)))
  const skippedFiles = loadedFiles
    .filter((result): result is SkippedLoadedFile => result.type === 'skipped')
    .map((result) => result.skippedFile)
  const instances = loadedFiles
    .filter((result): result is LoadedFile => result.type === 'loaded')
    .flatMap((result) => result.instances)

  if (instances.length === 0) {
    throw new Error('No DICOM image slices were found in the selected files.')
  }

  const seriesMap = new Map<string, DicomInstance[]>()

  instances.forEach((instance) => {
    const currentSeries = seriesMap.get(instance.seriesInstanceUid) ?? []
    currentSeries.push(instance)
    seriesMap.set(instance.seriesInstanceUid, currentSeries)
  })

  const seriesList = Array.from(seriesMap.entries())
    .map(([seriesInstanceUid, seriesInstances]) => {
      const sortedInstances = [...seriesInstances].sort(sortInstances)
      const representative = sortedInstances[0]
      const label = representative.seriesDescription || `Series ${seriesInstanceUid.slice(0, 8)}`

      return {
        seriesInstanceUid,
        label,
        studyDescription: representative.studyDescription,
        patientName: representative.patientName,
        modality: representative.modality,
        imageIds: sortedInstances.map((instance) => instance.imageId),
        instances: sortedInstances,
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label))

  return {
    seriesList,
    skippedFiles,
  }
}

async function loadDicomFile(file: File): Promise<LoadedFileResult> {
  const arrayBuffer = await file.arrayBuffer()
  const byteArray = new Uint8Array(arrayBuffer)

  try {
    const dataSet = dicomParser.parseDicom(byteArray)
    if (!dataSet.elements[PIXEL_DATA_TAG]) {
      return skipped(file.name, 'Missing pixel data')
    }

    const seriesInstanceUid = readString(dataSet, SERIES_INSTANCE_UID_TAG) ?? `series-${file.name}`
    const baseImageId = cornerstoneDICOMImageLoader.wadouri.fileManager.add(file)
    const numberOfFrames = Math.max(1, Math.trunc(readInteger(dataSet, NUMBER_OF_FRAMES_TAG) ?? 1))
    const patientName = formatPersonName(readString(dataSet, PATIENT_NAME_TAG) ?? 'Unknown patient')
    const studyInstanceUid = readString(dataSet, STUDY_INSTANCE_UID_TAG) ?? 'unknown-study'
    const studyDescription = readString(dataSet, STUDY_DESCRIPTION_TAG) ?? 'Unnamed study'
    const seriesDescription = readString(dataSet, SERIES_DESCRIPTION_TAG) ?? 'Unnamed series'
    const sopInstanceUid = readString(dataSet, SOP_INSTANCE_UID_TAG) ?? file.name
    const modality = readString(dataSet, MODALITY_TAG) ?? 'Unknown'
    const instanceNumber = readInteger(dataSet, INSTANCE_NUMBER_TAG)
    const imagePositionPatient = readNumberList(dataSet, IMAGE_POSITION_PATIENT_TAG)
    const sliceLocation = readNumber(dataSet, SLICE_LOCATION_TAG)
    const rows = readInteger(dataSet, ROWS_TAG)
    const columns = readInteger(dataSet, COLUMNS_TAG)
    const sliceThickness = readNumber(dataSet, SLICE_THICKNESS_TAG)
    const windowCenter = readNumber(dataSet, WINDOW_CENTER_TAG)
    const windowWidth = readNumber(dataSet, WINDOW_WIDTH_TAG)

    const instances = Array.from({ length: numberOfFrames }, (_, frameIndex) => {
      const frameNumber = numberOfFrames > 1 ? frameIndex + 1 : null
      const imageId = frameNumber ? `${baseImageId}&frame=${frameNumber}` : baseImageId

      return {
        imageId,
        fileName: frameNumber ? `${file.name} (frame ${frameNumber})` : file.name,
        frameNumber,
        patientName,
        studyInstanceUid,
        studyDescription,
        seriesInstanceUid,
        seriesDescription,
        sopInstanceUid,
        modality,
        instanceNumber,
        imagePositionPatient,
        sliceLocation,
        rows,
        columns,
        sliceThickness,
        windowCenter,
        windowWidth,
      }
    })

    return {
      type: 'loaded',
      instances,
    }
  } catch (error) {
    if (error instanceof Error) {
      return skipped(file.name, error.message)
    }

    throw error
  }
}

function skipped(fileName: string, reason: string): SkippedLoadedFile {
  return {
    type: 'skipped',
    skippedFile: {
      fileName,
      reason,
    },
  }
}

function readString(dataSet: dicomParser.DataSet, tag: string): string | null {
  const value = dataSet.string(tag)
  if (!value) {
    return null
  }

  return value.trim()
}

function readNumber(dataSet: dicomParser.DataSet, tag: string): number | null {
  const rawValue = readString(dataSet, tag)
  if (!rawValue) {
    return null
  }

  const firstValue = rawValue.split('\\')[0]
  const parsedValue = Number(firstValue)

  return Number.isFinite(parsedValue) ? parsedValue : null
}

function readInteger(dataSet: dicomParser.DataSet, tag: string): number | null {
  const parsedNumber = readNumber(dataSet, tag)
  if (parsedNumber !== null) {
    return Math.trunc(parsedNumber)
  }

  const uint16Value = dataSet.uint16(tag)
  return uint16Value !== undefined && Number.isFinite(uint16Value) ? uint16Value : null
}

function readNumberList(dataSet: dicomParser.DataSet, tag: string): number[] | null {
  const rawValue = readString(dataSet, tag)
  if (!rawValue) {
    return null
  }

  const values = rawValue
    .split('\\')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))

  return values.length > 0 ? values : null
}

function formatPersonName(personName: string): string {
  return personName.replace(/\^+/g, ' ').replace(/\s+/g, ' ').trim()
}

function sortInstances(left: DicomInstance, right: DicomInstance): number {
  if (left.sopInstanceUid === right.sopInstanceUid && left.frameNumber !== null && right.frameNumber !== null) {
    return left.frameNumber - right.frameNumber
  }

  if (left.instanceNumber !== null && right.instanceNumber !== null) {
    return left.instanceNumber - right.instanceNumber
  }

  const leftZ = left.imagePositionPatient?.[2] ?? left.sliceLocation
  const rightZ = right.imagePositionPatient?.[2] ?? right.sliceLocation

  if (leftZ !== null && leftZ !== undefined && rightZ !== null && rightZ !== undefined) {
    return leftZ - rightZ
  }

  return left.fileName.localeCompare(right.fileName)
}
