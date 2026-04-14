export type ModalityKey = 'mri' | 'xray' | 'skin-lesions'

export interface ModalityDefinition {
  key: ModalityKey
  label: string
  shortLabel: string
  path: string
  summary: string
  status: 'available' | 'planned'
  defaultPrompt?: string
}

export const APP_TITLE = 'DocBob Imaging Workbench'
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:8000/api' : '/api')
export const STACK_ANALYSIS_SNAPSHOT_LIMIT = 24

export const MRI_MODALITY: ModalityDefinition = {
  key: 'mri',
  label: 'MRI review console',
  shortLabel: 'MRI',
  path: '/mri',
  status: 'available',
  summary:
    'Upload local MRI DICOM studies, inspect them in-browser, and request a concise assistive interpretation from the configured multimodal gateway.',
  defaultPrompt:
    'Review these MRI images as one study. When multiple rendered slices are provided, treat them as ordered representative views of the same series and synthesize one concise study-level response. Output exactly two short sections labeled "Summary:" and "Impression:". Use no more than four sentences total. Mention only the most important findings. If no obvious abnormality is visible, say that once plainly. Do not describe each slice separately, do not list every normal structure, and do not repeat negative findings.',
}

export const PLANNED_MODALITIES: ModalityDefinition[] = [
  {
    key: 'xray',
    label: 'X-ray review console',
    shortLabel: 'X-ray',
    path: '/xray',
    status: 'planned',
    summary:
      'The shared shell is being prepared for a dedicated X-ray workflow with the same interaction model and deployment path.',
  },
  {
    key: 'skin-lesions',
    label: 'Skin lesion review console',
    shortLabel: 'Skin lesions',
    path: '/skin-lesions',
    status: 'planned',
    summary:
      'The landing and API architecture will support a separate skin-lesion workflow without forcing the MRI interface to carry unrelated UX.',
  },
]
