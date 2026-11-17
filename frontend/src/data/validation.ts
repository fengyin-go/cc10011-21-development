import seedData from './validation-seed.json'

// 校验结果结构版本：批次明细、异常证据、落盘清单都按这个版本落库。
// 构建时 scripts/verify-validation-schema.mjs 会把它当依赖校验，版本不一致直接构建失败。
export const VALIDATION_SCHEMA_VERSION = 'validation-result/v1'

// 校验执行域独立一个 localStorage key：采样结论、异常证据、落盘阻断、隔离区、落盘清单
// 在一次 setItem 里一起提交，保存失败时整体不落库，不会出现「已判通过但证据丢失」。
export const VALIDATION_STORAGE_KEY = 'scraper-strategy-studio:validation'

export type FinalConclusion = '通过' | '阻断' | '未决'
export type DisposalStrategy = '' | '样本越阈值立即阻断' | '先扩展校验范围再作结论'
export type CheckStatus = '成功' | '校验失败'
export type StorageState = '待落盘' | '已落盘' | '已阻断' | '隔离中'

export type CollectionRow = {
  行号: string
  采集批次: string
  目标站点: string
  数据内容: string
  采集时间: string
  异常标记: boolean
  异常原因: string
}

export type EvidenceItem = {
  行号: string
  校验项: string
  异常原因: string
  证据快照: string
}

export type ConfirmRecord = {
  时间: string
  操作人: string
  动作: string
  结论: string
  依据: string
}

export type ValidationBatch = {
  批次编号: string
  幂等键: string
  采集批次: string
  规则编号: string
  校验类型: string
  采样比例: string
  异常阈值: string
  样本总数: number
  异常样本数: number
  异常率: string
  最终结论: FinalConclusion
  处置策略: DisposalStrategy
  冲突待判定: boolean
  校验状态: CheckStatus
  落盘状态: StorageState
  结构版本: string
  异常证据: EvidenceItem[]
  确认历史: ConfirmRecord[]
  数据凭据: string
  复核依据: string
  校验人: string
  校验时间: string
}

export type IsolationRow = {
  行号: string
  来源批次: string
  采集批次: string
  异常原因: string
  隔离原因: string
  状态: '等待复核' | '已放行' | '已作废'
  入区时间: string
}

export type LedgerRow = {
  清单编号: string
  来源批次: string
  规则编号: string
  通过行数: number
  存储配置: string
  落盘时间: string
  状态: '已落盘' | '已冻结'
}

export type ValidationStore = {
  collection: CollectionRow[]
  batches: ValidationBatch[]
  isolation: IsolationRow[]
  ledger: LedgerRow[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedStore(): ValidationStore {
  return clone(seedData) as ValidationStore
}

// 每次操作前都重新读 localStorage：重试、并发页签看到的都是最新已提交状态。
export function loadValidationStore(): ValidationStore {
  const fallback = seedStore()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(VALIDATION_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(VALIDATION_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ValidationStore>
    return {
      collection: parsed.collection ?? fallback.collection,
      batches: parsed.batches ?? fallback.batches,
      isolation: parsed.isolation ?? fallback.isolation,
      ledger: parsed.ledger ?? fallback.ledger,
    }
  } catch {
    window.localStorage.setItem(VALIDATION_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

// 唯一的写入口：整棵校验域状态一次 setItem 提交。调用方先在内存里把
// 结论、证据、阻断、隔离区、落盘清单全部算好，这里要么全写要么不写。
export function persistValidationStore(store: ValidationStore): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(VALIDATION_STORAGE_KEY, JSON.stringify(store))
  }
}

export function resetValidationStore(): ValidationStore {
  const fresh = seedStore()
  persistValidationStore(fresh)
  return fresh
}
