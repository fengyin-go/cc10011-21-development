#!/usr/bin/env node
// 校验结果结构版本的构建期校验：把 src/data/validation.ts 里的 VALIDATION_SCHEMA_VERSION
// 当作依赖，核对种子数据里每条结果校验批次明细的结构版本与必填字段。
// 任一检查失败即退出码 1，阻断构建；通过后才允许打包部署到测试环境。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function fail(message) {
  failures.push(message)
}

// 1. 从数据层源码提取当前结构版本依赖
const source = readFileSync(join(root, 'src/data/validation.ts'), 'utf-8')
const versionMatch = /VALIDATION_SCHEMA_VERSION\s*=\s*'([^']+)'/.exec(source)
if (!versionMatch) {
  fail('src/data/validation.ts 中没有找到 VALIDATION_SCHEMA_VERSION 常量')
}
const schemaVersion = versionMatch?.[1]

// 2. 读取种子数据，逐条核对批次明细
const seed = JSON.parse(readFileSync(join(root, 'src/data/validation-seed.json'), 'utf-8'))

const CONCLUSIONS = new Set(['通过', '阻断', '未决'])
const STORAGE_STATES = new Set(['待落盘', '已落盘', '已阻断', '隔离中'])
const REQUIRED_FIELDS = ['批次编号', '幂等键', '采集批次', '规则编号', '校验类型', '最终结论', '落盘状态', '结构版本', '数据凭据']

const batchNos = new Set()
const idemKeys = new Set()
for (const batch of seed.batches ?? []) {
  const label = batch.批次编号 ?? '(缺批次编号)'
  for (const field of REQUIRED_FIELDS) {
    if (batch[field] === undefined || batch[field] === '') {
      fail(`批次 ${label} 缺少必填字段「${field}」`)
    }
  }
  if (batch.结构版本 !== schemaVersion) {
    fail(`批次 ${label} 结构版本「${batch.结构版本}」与依赖版本「${schemaVersion}」不一致`)
  }
  if (!CONCLUSIONS.has(batch.最终结论)) {
    fail(`批次 ${label} 最终结论「${batch.最终结论}」非法，只能是通过/阻断/未决`)
  }
  if (!STORAGE_STATES.has(batch.落盘状态)) {
    fail(`批次 ${label} 落盘状态「${batch.落盘状态}」非法`)
  }
  if (!Array.isArray(batch.异常证据)) {
    fail(`批次 ${label} 异常证据必须是数组（允许为空数组）`)
  }
  if (!Array.isArray(batch.确认历史)) {
    fail(`批次 ${label} 确认历史必须是数组`)
  }
  if (batchNos.has(batch.批次编号)) {
    fail(`批次编号 ${label} 重复：同一批次只能有一条明细、一个最终结论`)
  }
  batchNos.add(batch.批次编号)
  if (idemKeys.has(batch.幂等键)) {
    fail(`幂等键 ${batch.幂等键} 重复：同一采集批次+规则重复校验必须 upsert 到同一条明细`)
  }
  idemKeys.add(batch.幂等键)
}

// 3. 隔离区与落盘清单必须能回溯到批次明细
for (const row of seed.isolation ?? []) {
  if (!batchNos.has(row.来源批次)) {
    fail(`隔离区行 ${row.行号} 的来源批次 ${row.来源批次} 不存在`)
  }
}
for (const row of seed.ledger ?? []) {
  if (!batchNos.has(row.来源批次)) {
    fail(`落盘清单 ${row.清单编号} 的来源批次 ${row.来源批次} 不存在`)
  }
}

if (failures.length > 0) {
  console.error(`✗ 校验结果结构版本校验失败（依赖版本 ${schemaVersion ?? '未知'}）：`)
  for (const item of failures) {
    console.error(`  - ${item}`)
  }
  process.exit(1)
}
console.log(`✓ 校验结果结构版本 ${schemaVersion} 校验通过：${batchNos.size} 条批次明细、${(seed.isolation ?? []).length} 条隔离区记录、${(seed.ledger ?? []).length} 条落盘清单`)
