import { listRows } from '@/data/local-store'
import {
  VALIDATION_SCHEMA_VERSION,
  loadValidationStore,
  persistValidationStore,
} from '@/data/validation'
import type {
  CollectionRow,
  ConfirmRecord,
  EvidenceItem,
  ValidationBatch,
  ValidationStore,
} from '@/data/validation'
import type { ActionResult } from '@/data/types'

// 抽样异常率刚超阈值、但超出部分在这个余量内时，不直接拍死：
// 「样本越阈值立即阻断」和「先扩展校验范围再作结论」两种做法都成立，形成冲突，交复核员判定。
const CONFLICT_MARGIN = 0.05

const BLOCK_IMMEDIATE = '样本越阈值立即阻断' as const
const EXPAND_FIRST = '先扩展校验范围再作结论' as const

export type CollectionBatchInfo = {
  采集批次: string
  行数: number
  异常行数: number
  已校验: boolean
}

function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function today(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}${mm}${dd}`
}

function parsePercent(text: string, fallback: number): number {
  const matched = /(\d+(?:\.\d+)?)\s*%/.exec(String(text ?? ''))
  if (matched) {
    return Number(matched[1]) / 100
  }
  const raw = Number(text)
  if (Number.isFinite(raw) && raw > 0) {
    return raw > 1 ? raw / 100 : raw
  }
  return fallback
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`
}

// 确定性抽样：按行号排序后等距取样，同一批次同一比例抽到的永远是同一批样本，可复核可复现。
function sampleRows(rows: CollectionRow[], ratio: number): CollectionRow[] {
  const sorted = [...rows].sort((a, b) => a.行号.localeCompare(b.行号))
  const step = Math.max(1, Math.round(1 / Math.min(Math.max(ratio, 0.01), 1)))
  return sorted.filter((_, index) => index % step === 0)
}

function toEvidence(rows: CollectionRow[], checkType: string): EvidenceItem[] {
  return rows
    .filter((row) => row.异常标记)
    .map((row) => ({
      行号: row.行号,
      校验项: checkType,
      异常原因: row.异常原因 || '未通过校验',
      证据快照: row.数据内容,
    }))
}

function nextNumber(items: string[], prefix: string): string {
  const max = items.reduce((acc, item) => {
    const matched = new RegExp(`^${prefix}-(\\d+)$`).exec(item)
    return matched ? Math.max(acc, Number(matched[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function findRule(ruleCode: string) {
  return listRows('validator').find((row) => String(row['规则编号']) === ruleCode)
}

function enabledStorageConfig(): string {
  const enabled = listRows('storage').find((row) => String(row.status) === '已启用')
  return String(enabled?.['配置编号'] ?? 'STOR-0001')
}

// 原子提交入口：先在内存里把整棵校验域状态改完，再一次 setItem 落库。
// 任何一步抛错都不会写盘，采样结论、异常证据、落盘阻断同生共死。
function commit(mutate: (store: ValidationStore) => ActionResult & { batch?: ValidationBatch }): ActionResult & { batch?: ValidationBatch } {
  const store = loadValidationStore()
  let result: ActionResult & { batch?: ValidationBatch }
  try {
    result = mutate(store)
  } catch (error) {
    return { ok: false, message: `校验执行异常，未写入任何结论或证据：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!result.ok) {
    return result
  }
  try {
    persistValidationStore(store)
  } catch (error) {
    return { ok: false, message: `保存失败，结论与证据均未落盘，请重试：${error instanceof Error ? error.message : String(error)}` }
  }
  return result
}

// 数据落盘清单联动：批次最终结论变化时，同步冻结/放行该批次的落盘记录；
// 已落库的记录保留原采样状态，只动后续未落盘的部分。
function syncLedger(store: ValidationStore, batch: ValidationBatch): void {
  for (const row of store.ledger) {
    if (row.来源批次 !== batch.批次编号) {
      continue
    }
    if (batch.最终结论 === '通过') {
      if (row.状态 === '已冻结') {
        row.状态 = '已落盘'
      }
    } else if (row.状态 !== '已落盘') {
      row.状态 = '已冻结'
    }
  }
}

// 隔离区承接：未决或阻断的批次，其数据行保留在隔离区等待复核；通过后整批放行出区。
function syncIsolation(store: ValidationStore, batch: ValidationBatch, rows: CollectionRow[]): void {
  const kept = store.isolation.filter((row) => row.来源批次 !== batch.批次编号)
  if (batch.最终结论 === '通过') {
    store.isolation = kept
    return
  }
  const evidenceRows = new Set(batch.异常证据.map((item) => item.行号))
  const reason = batch.最终结论 === '阻断' ? '批次阻断' : '结论未决'
  const entrants = rows.map((row) => ({
    行号: row.行号,
    来源批次: batch.批次编号,
    采集批次: batch.采集批次,
    异常原因: evidenceRows.has(row.行号) ? row.异常原因 || '未通过校验' : '',
    隔离原因: reason,
    状态: '等待复核' as const,
    入区时间: now(),
  }))
  store.isolation = [...kept, ...entrants]
}

export function listCollectionBatches(): CollectionBatchInfo[] {
  const store = loadValidationStore()
  const checkedKeys = new Set(store.batches.map((batch) => batch.幂等键))
  const grouped = new Map<string, CollectionRow[]>()
  for (const row of store.collection) {
    const list = grouped.get(row.采集批次) ?? []
    list.push(row)
    grouped.set(row.采集批次, list)
  }
  return [...grouped.entries()].map(([采集批次, rows]) => ({
    采集批次,
    行数: rows.length,
    异常行数: rows.filter((row) => row.异常标记).length,
    已校验: [...checkedKeys].some((key) => key.startsWith(`${采集批次}__`)),
  }))
}

export function listValidationBatches(): ValidationBatch[] {
  return loadValidationStore().batches
}

export function listIsolationRows() {
  return loadValidationStore().isolation
}

export function listLedgerRows() {
  return loadValidationStore().ledger
}

// 校验执行：读取待校验采集数据 + 规则的采样比例与异常阈值，抽样校验、归并异常证据，
// 生成结果校验批次明细。同一采集批次 + 同一规则重复执行是 upsert：
// 批次明细里永远只有一条记录、一个最终结论，不会同时存在通过与阻断。
export function executeValidation(ruleCode: string, collectionBatch: string, operator: string): ActionResult & { batch?: ValidationBatch } {
  const rule = findRule(ruleCode)
  if (!rule) {
    return { ok: false, message: `没有找到规则编号为 ${ruleCode} 的校验规则` }
  }
  return commit((store) => {
    const rows = store.collection.filter((row) => row.采集批次 === collectionBatch)
    const idemKey = `${collectionBatch}__${ruleCode}`
    const existing = store.batches.find((batch) => batch.幂等键 === idemKey)
    const credential = existing?.数据凭据 || `CRED-${today()}-${existing?.批次编号 ?? nextNumber(store.batches.map((b) => b.批次编号), 'VB')}`

    if (rows.length === 0) {
      return { ok: false, message: `采集批次 ${collectionBatch} 没有待校验数据，校验失败` }
    }
    if (rows.some((row) => !row.行号)) {
      // 数据凭据问题：行号缺失无法归并证据，判校验失败，可重试恢复。
      const failed = upsertBatch(store, existing, {
        幂等键: idemKey,
        采集批次: collectionBatch,
        规则编号: ruleCode,
        校验类型: String(rule['校验类型'] ?? ''),
        采样比例: String(rule['采样比例'] ?? ''),
        异常阈值: String(rule['异常阈值'] ?? ''),
        样本总数: 0,
        异常样本数: 0,
        异常率: '—',
        最终结论: '未决',
        处置策略: '',
        冲突待判定: false,
        校验状态: '校验失败',
        落盘状态: '隔离中',
        结构版本: VALIDATION_SCHEMA_VERSION,
        异常证据: [],
        数据凭据: credential,
        复核依据: '',
        校验人: operator,
        校验时间: now(),
      }, { 时间: now(), 操作人: operator, 动作: '执行采样', 结论: '校验失败', 依据: '采集数据行号缺失，证据无法归并' })
      syncIsolation(store, failed, rows)
      return { ok: true, message: `批次 ${failed.批次编号} 校验失败：采集数据行号缺失，可重试恢复`, batch: failed }
    }

    const ratio = parsePercent(String(rule['采样比例'] ?? ''), 0.1)
    const threshold = parsePercent(String(rule['异常阈值'] ?? ''), 0.1)
    const samples = sampleRows(rows, ratio)
    const evidence = toEvidence(samples, String(rule['校验类型'] ?? ''))
    const rate = samples.length === 0 ? 0 : evidence.length / samples.length

    let conclusion: ValidationBatch['最终结论']
    let strategy: ValidationBatch['处置策略']
    let conflict = false
    let basis: string
    if (rate <= threshold) {
      conclusion = '通过'
      strategy = ''
      basis = `样本异常率 ${formatPercent(rate)} 未超阈值 ${formatPercent(threshold)}`
    } else if (rate <= threshold + CONFLICT_MARGIN) {
      // 刚超阈值：全量结果仍可能达标，两种处置形成冲突，挂起等复核员判定。
      conclusion = '未决'
      strategy = ''
      conflict = true
      basis = `样本异常率 ${formatPercent(rate)} 刚超阈值 ${formatPercent(threshold)}，待判定处置方式`
    } else {
      conclusion = '阻断'
      strategy = BLOCK_IMMEDIATE
      basis = `样本异常率 ${formatPercent(rate)} 超阈值 ${formatPercent(threshold)}`
    }

    const history: ConfirmRecord[] = [
      { 时间: now(), 操作人: operator, 动作: '执行采样', 结论: conclusion, 依据: basis },
    ]
    if (strategy === BLOCK_IMMEDIATE) {
      history.push({ 时间: now(), 操作人: '系统', 动作: BLOCK_IMMEDIATE, 结论: '阻断', 依据: BLOCK_IMMEDIATE })
    }
    if (conflict) {
      history.push({ 时间: now(), 操作人: '系统', 动作: '冲突登记', 结论: '未决', 依据: `可选「${BLOCK_IMMEDIATE}」或「${EXPAND_FIRST}」` })
    }

    const batch = upsertBatch(store, existing, {
      幂等键: idemKey,
      采集批次: collectionBatch,
      规则编号: ruleCode,
      校验类型: String(rule['校验类型'] ?? ''),
      采样比例: String(rule['采样比例'] ?? ''),
      异常阈值: String(rule['异常阈值'] ?? ''),
      样本总数: samples.length,
      异常样本数: evidence.length,
      异常率: formatPercent(rate),
      最终结论: conclusion,
      处置策略: strategy,
      冲突待判定: conflict,
      校验状态: '成功',
      落盘状态: conclusion === '通过' ? '待落盘' : conclusion === '阻断' ? '已阻断' : '隔离中',
      结构版本: VALIDATION_SCHEMA_VERSION,
      异常证据: evidence,
      数据凭据: credential,
      复核依据: strategy === BLOCK_IMMEDIATE ? BLOCK_IMMEDIATE : '',
      校验人: operator,
      校验时间: now(),
    }, ...history)
    syncIsolation(store, batch, rows)
    syncLedger(store, batch)
    return { ok: true, message: `批次 ${batch.批次编号} 校验完成，最终结论「${batch.最终结论}」${conflict ? '，存在处置冲突待判定' : ''}`, batch }
  })
}

// upsert 核心：同一幂等键只保留一条批次明细；重复校验时把上一份确认记录压入历史再覆盖，
// 保证任何时刻一个批次只有一个最终结论。
function upsertBatch(
  store: ValidationStore,
  existing: ValidationBatch | undefined,
  patch: Omit<ValidationBatch, '批次编号' | '确认历史'>,
  ...records: ConfirmRecord[]
): ValidationBatch {
  const prior: ConfirmRecord[] = existing
    ? [{ 时间: now(), 操作人: '系统', 动作: '重校验归档', 结论: existing.最终结论, 依据: `上一份确认记录（${existing.校验时间}）` }]
    : []
  if (existing) {
    Object.assign(existing, patch, { 确认历史: [...existing.确认历史, ...prior, ...records] })
    return existing
  }
  const batch: ValidationBatch = {
    ...patch,
    批次编号: nextNumber(store.batches.map((item) => item.批次编号), 'VB'),
    确认历史: [...prior, ...records],
  }
  store.batches.push(batch)
  return batch
}

// 失败后重试并恢复：保留上一份确认记录与本日数据凭据；
// 若此前有「样本越阈值立即阻断」记录，先补记核对记录作为复核依据，再重新执行。
export function retryValidation(batchNo: string, operator: string): ActionResult & { batch?: ValidationBatch } {
  const store = loadValidationStore()
  const batch = store.batches.find((item) => item.批次编号 === batchNo)
  if (!batch) {
    return { ok: false, message: `没有找到批次编号为 ${batchNo} 的结果校验批次明细` }
  }
  const { 采集批次, 规则编号 } = batch
  // 恢复处理：为缺失行号的采集数据补发临时行号，让证据可以归并。
  let recovered = 0
  for (const row of store.collection) {
    if (row.采集批次 === 采集批次 && !row.行号) {
      recovered += 1
      row.行号 = `${采集批次}-RECOVERED-${String(recovered).padStart(3, '0')}`
    }
  }
  try {
    persistValidationStore(store)
  } catch (error) {
    return { ok: false, message: `恢复数据保存失败，未触发重试：${error instanceof Error ? error.message : String(error)}` }
  }
  const result = executeValidation(规则编号, 采集批次, operator)
  if (!result.ok || !result.batch) {
    return result
  }
  return commit((store2) => {
    const current = store2.batches.find((item) => item.批次编号 === result.batch!.批次编号)
    if (!current) {
      return { ok: false, message: '重试后批次明细丢失，请重新执行校验' }
    }
    if (recovered > 0) {
      current.确认历史.push({ 时间: now(), 操作人: operator, 动作: '重试恢复', 结论: current.最终结论, 依据: `补发临时行号 ${recovered} 行后重试` })
    }
    if (current.处置策略 === BLOCK_IMMEDIATE || current.复核依据 === BLOCK_IMMEDIATE) {
      current.复核依据 = BLOCK_IMMEDIATE
      current.确认历史.push({ 时间: now(), 操作人: operator, 动作: '重试核对', 结论: current.最终结论, 依据: BLOCK_IMMEDIATE })
    }
    return { ok: true, message: `批次 ${current.批次编号} 重试完成，最终结论「${current.最终结论}」，上一份确认记录与本日数据凭据已留存`, batch: current }
  })
}

// 冲突判定：抽样异常率刚超阈值时，两种做法让数据落盘状态不同——
// 「样本越阈值立即阻断」直接断供落盘；「先扩展校验范围再作结论」按全量结果定结论。
// 判定结果写回同一条批次明细，结论依旧唯一，供复核。
export function resolveConflict(batchNo: string, decision: typeof BLOCK_IMMEDIATE | typeof EXPAND_FIRST, operator: string): ActionResult & { batch?: ValidationBatch } {
  return commit((store) => {
    const batch = store.batches.find((item) => item.批次编号 === batchNo)
    if (!batch) {
      return { ok: false, message: `没有找到批次编号为 ${batchNo} 的结果校验批次明细` }
    }
    if (!batch.冲突待判定) {
      return { ok: false, message: `批次 ${batchNo} 没有待判定的处置冲突` }
    }
    const rows = store.collection.filter((row) => row.采集批次 === batch.采集批次)
    batch.确认历史.push({ 时间: now(), 操作人: operator, 动作: '冲突判定', 结论: decision, 依据: `复核员选择「${decision}」` })

    if (decision === BLOCK_IMMEDIATE) {
      batch.最终结论 = '阻断'
      batch.处置策略 = BLOCK_IMMEDIATE
      batch.落盘状态 = '已阻断'
      batch.复核依据 = BLOCK_IMMEDIATE
      batch.确认历史.push({ 时间: now(), 操作人: '系统', 动作: BLOCK_IMMEDIATE, 结论: '阻断', 依据: BLOCK_IMMEDIATE })
    } else {
      // 扩展校验范围：全量重检，按全量异常率出最终结论。
      const fullEvidence = toEvidence(rows, batch.校验类型)
      const fullRate = rows.length === 0 ? 0 : fullEvidence.length / rows.length
      const threshold = parsePercent(batch.异常阈值, 0.1)
      batch.处置策略 = EXPAND_FIRST
      batch.样本总数 = rows.length
      batch.异常样本数 = fullEvidence.length
      batch.异常率 = formatPercent(fullRate)
      batch.异常证据 = fullEvidence
      if (fullRate <= threshold) {
        batch.最终结论 = '通过'
        batch.落盘状态 = '待落盘'
        batch.复核依据 = ''
      } else {
        batch.最终结论 = '阻断'
        batch.落盘状态 = '已阻断'
        batch.复核依据 = BLOCK_IMMEDIATE
        batch.确认历史.push({ 时间: now(), 操作人: '系统', 动作: BLOCK_IMMEDIATE, 结论: '阻断', 依据: `全量异常率 ${formatPercent(fullRate)} 仍超阈值` })
      }
      batch.确认历史.push({ 时间: now(), 操作人: operator, 动作: EXPAND_FIRST, 结论: batch.最终结论, 依据: `全量异常率 ${formatPercent(fullRate)}（阈值 ${batch.异常阈值}）` })
    }
    batch.冲突待判定 = false
    batch.校验人 = operator
    batch.校验时间 = now()
    syncIsolation(store, batch, rows)
    syncLedger(store, batch)
    return { ok: true, message: `批次 ${batch.批次编号} 冲突已判定为「${decision}」，最终结论「${batch.最终结论}」`, batch }
  })
}

// 数据落盘回写：跟随业务调用找到结果校验批次明细的变更节点，先核对「样本越阈值立即阻断」——
// 命中阻断的批次直接拒绝落盘；只有结论为通过的数据行进入落盘清单（待处理区），
// 未决或阻断记录保留在隔离区等待复核。完成落库后批次保留原采样状态。
export function writebackStorage(batchNo: string, operator: string): ActionResult {
  return commit((store) => {
    const batch = store.batches.find((item) => item.批次编号 === batchNo)
    if (!batch) {
      return { ok: false, message: `没有找到批次编号为 ${batchNo} 的结果校验批次明细` }
    }
    if (batch.复核依据 === BLOCK_IMMEDIATE || batch.处置策略 === BLOCK_IMMEDIATE) {
      if (batch.最终结论 !== '通过') {
        return { ok: false, message: `批次 ${batchNo} 命中「${BLOCK_IMMEDIATE}」核对记录，落盘已阻断，异常行保留在隔离区等待复核` }
      }
    }
    if (batch.最终结论 === '阻断') {
      return { ok: false, message: `批次 ${batchNo} 最终结论为阻断，数据行保留在隔离区等待复核` }
    }
    if (batch.最终结论 === '未决') {
      return { ok: false, message: `批次 ${batchNo} 结论未决，数据行保留在隔离区，待冲突判定后再落盘` }
    }
    if (batch.落盘状态 === '已落盘') {
      return { ok: false, message: `批次 ${batchNo} 已完成落盘，不用重复回写` }
    }
    const rows = store.collection.filter((row) => row.采集批次 === batch.采集批次)
    const passedRows = Math.max(rows.length - batch.异常证据.length, 0)
    store.ledger.push({
      清单编号: nextNumber(store.ledger.map((item) => item.清单编号), 'WL'),
      来源批次: batch.批次编号,
      规则编号: batch.规则编号,
      通过行数: passedRows,
      存储配置: enabledStorageConfig(),
      落盘时间: now(),
      状态: '已落盘',
    })
    // 只更新落盘状态，采样结论、异常证据、处置策略原样保留。
    batch.落盘状态 = '已落盘'
    batch.确认历史.push({ 时间: now(), 操作人: operator, 动作: '落盘回写', 结论: batch.最终结论, 依据: `通过 ${passedRows} 行写入落盘清单，原采样状态保留` })
    syncLedger(store, batch)
    return { ok: true, message: `批次 ${batch.批次编号} 已回写落盘清单，通过 ${passedRows} 行，原采样状态保留` }
  })
}

// 复核员核对「样本越阈值立即阻断」产生的核对记录：只补确认记录，不改最终结论。
export function acknowledgeReview(batchNo: string, operator: string): ActionResult {
  return commit((store) => {
    const batch = store.batches.find((item) => item.批次编号 === batchNo)
    if (!batch) {
      return { ok: false, message: `没有找到批次编号为 ${batchNo} 的结果校验批次明细` }
    }
    const hasBlockRecord = batch.确认历史.some((record) => record.动作 === BLOCK_IMMEDIATE)
    if (!hasBlockRecord) {
      return { ok: false, message: `批次 ${batchNo} 没有「${BLOCK_IMMEDIATE}」核对记录` }
    }
    batch.确认历史.push({ 时间: now(), 操作人: operator, 动作: '复核确认', 结论: batch.最终结论, 依据: `复核依据：${BLOCK_IMMEDIATE}` })
    return { ok: true, message: `批次 ${batch.批次编号} 的「${BLOCK_IMMEDIATE}」核对记录已复核确认` }
  })
}
