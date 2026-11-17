import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  acknowledgeReview,
  executeValidation,
  listCollectionBatches,
  listValidationBatches,
  resolveConflict,
  retryValidation,
  writebackStorage,
} from '@/api/validation-service'
import { listRows } from '@/data/local-store'
import type { CollectionBatchInfo } from '@/api/validation-service'
import type { ValidationBatch } from '@/data/validation'

type Role = '校验员' | '复核员'

const BLOCK_IMMEDIATE = '样本越阈值立即阻断'
const EXPAND_FIRST = '先扩展校验范围再作结论'

function conclusionBadge(conclusion: string) {
  if (conclusion === '通过') return 'badge ok'
  if (conclusion === '阻断') return 'badge block'
  return 'badge pending'
}

function storageBadge(state: string) {
  if (state === '已落盘') return 'badge ok'
  if (state === '已阻断') return 'badge block'
  return 'badge pending'
}

export default function ValidationExecution() {
  const [role, setRole] = useState<Role>('校验员')
  const [operator, setOperator] = useState('校验员-林一')
  const [ruleCode, setRuleCode] = useState('')
  const [collectionBatch, setCollectionBatch] = useState('')
  const [batches, setBatches] = useState<ValidationBatch[]>([])
  const [collectionBatches, setCollectionBatches] = useState<CollectionBatchInfo[]>([])
  const [expanded, setExpanded] = useState<string>('')
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const rules = useMemo(
    () => listRows('validator').map((row) => ({ code: String(row['规则编号']), type: String(row['校验类型']), ratio: String(row['采样比例']), threshold: String(row['异常阈值']) })),
    [],
  )

  const reload = useCallback(() => {
    setBatches(listValidationBatches())
    setCollectionBatches(listCollectionBatches())
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    setOperator(role === '校验员' ? '校验员-林一' : '复核员-周衡')
  }, [role])

  function report(result: { ok: boolean; message: string }) {
    if (result.ok) {
      setMessage(result.message)
      setErrorMessage('')
    } else {
      setErrorMessage(result.message)
      setMessage('')
    }
    reload()
  }

  function onExecute() {
    if (!ruleCode || !collectionBatch) {
      setErrorMessage('请先选择校验规则和待校验采集批次')
      setMessage('')
      return
    }
    report(executeValidation(ruleCode, collectionBatch, operator))
  }

  const selectedBatchInfo = collectionBatches.find((item) => item.采集批次 === collectionBatch)

  return (
    <section className="exec-panel" data-module="validation-execution">
      <header className="page-head">
        <div>
          <h3>校验执行台</h3>
          <p className="page-desc">
            读取待校验采集数据、采样比例与异常阈值，抽样校验并归并异常证据，生成结果校验批次明细。
            每个采样批次只有一个最终校验结论，异常行带证据；未决或阻断记录保留在隔离区等待复核。
          </p>
        </div>
        <div className="page-actions role-switch">
          <span className="role-label">当前角色</span>
          {(['校验员', '复核员'] as Role[]).map((item) => (
            <button
              key={item}
              type="button"
              className={role === item ? 'btn primary' : 'btn ghost'}
              onClick={() => setRole(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </header>

      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          onExecute()
        }}
      >
        <label className="filter-item">
          <span>校验规则</span>
          <select value={ruleCode} onChange={(event) => setRuleCode(event.target.value)}>
            <option value="">选择规则编号</option>
            {rules.map((rule) => (
              <option key={rule.code} value={rule.code}>
                {rule.code}（{rule.type} 采样{rule.ratio} 阈值{rule.threshold}）
              </option>
            ))}
          </select>
        </label>
        <label className="filter-item">
          <span>待校验采集批次</span>
          <select value={collectionBatch} onChange={(event) => setCollectionBatch(event.target.value)}>
            <option value="">选择采集批次</option>
            {collectionBatches.map((item) => (
              <option key={item.采集批次} value={item.采集批次}>
                {item.采集批次}（{item.行数} 行{item.已校验 ? '，已校验' : ''}）
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" type="submit" disabled={role !== '校验员'}>
          执行采样
        </button>
        {selectedBatchInfo && (
          <span className="hint-text">
            该批次 {selectedBatchInfo.行数} 行，预置异常 {selectedBatchInfo.异常行数} 行
          </span>
        )}
      </form>
      {role !== '校验员' && <p className="hint-text">复核员可判定冲突与核对记录；执行采样、重试请切换到校验员。</p>}

      <table className="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>规则编号</th>
            <th>校验类型</th>
            <th>采样比例</th>
            <th>异常阈值</th>
            <th>样本/异常</th>
            <th>异常率</th>
            <th>最终结论</th>
            <th>处置策略</th>
            <th>落盘状态</th>
            <th>结构版本</th>
            <th>校验人</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <BatchRows
              key={batch.批次编号}
              batch={batch}
              role={role}
              expanded={expanded === batch.批次编号}
              onToggle={() => setExpanded(expanded === batch.批次编号 ? '' : batch.批次编号)}
              onRetry={() => report(retryValidation(batch.批次编号, operator))}
              onResolve={(decision) => report(resolveConflict(batch.批次编号, decision, operator))}
              onWriteback={() => report(writebackStorage(batch.批次编号, operator))}
              onAck={() => report(acknowledgeReview(batch.批次编号, operator))}
            />
          ))}
          {batches.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={13}>暂无结果校验批次明细，请先执行采样</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {batches.length} 个采样批次，每批次仅一条最终结论；采样结论、异常证据与落盘阻断一起提交</span>
        {message && <span className="ok-text">{message}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}

function BatchRows(props: {
  batch: ValidationBatch
  role: Role
  expanded: boolean
  onToggle: () => void
  onRetry: () => void
  onResolve: (decision: typeof BLOCK_IMMEDIATE | typeof EXPAND_FIRST) => void
  onWriteback: () => void
  onAck: () => void
}) {
  const { batch, role, expanded } = props
  const hasBlockRecord = batch.确认历史.some((record) => record.动作 === BLOCK_IMMEDIATE)
  return (
    <>
      <tr>
        <td>{batch.批次编号}</td>
        <td>{batch.规则编号}</td>
        <td>{batch.校验类型}</td>
        <td>{batch.采样比例}</td>
        <td>{batch.异常阈值}</td>
        <td>{batch.样本总数} / {batch.异常样本数}</td>
        <td>{batch.异常率}</td>
        <td>
          <span className={conclusionBadge(batch.最终结论)}>{batch.最终结论}</span>
          {batch.校验状态 === '校验失败' && <span className="badge block">校验失败</span>}
          {batch.冲突待判定 && <span className="badge pending">冲突待判定</span>}
        </td>
        <td>{batch.处置策略 || '—'}</td>
        <td><span className={storageBadge(batch.落盘状态)}>{batch.落盘状态}</span></td>
        <td>{batch.结构版本}</td>
        <td>{batch.校验人}</td>
        <td className="row-actions">
          <button className="link" type="button" onClick={props.onToggle}>
            {expanded ? '收起证据' : '查看证据'}
          </button>
          {role === '校验员' && (batch.校验状态 === '校验失败' || batch.最终结论 === '未决') && !batch.冲突待判定 && (
            <button className="link" type="button" onClick={props.onRetry}>重试</button>
          )}
          {role === '复核员' && batch.冲突待判定 && (
            <>
              <button className="link" type="button" onClick={() => props.onResolve(BLOCK_IMMEDIATE)}>立即阻断</button>
              <button className="link" type="button" onClick={() => props.onResolve(EXPAND_FIRST)}>扩展校验范围</button>
            </>
          )}
          {role === '校验员' && batch.最终结论 === '通过' && batch.落盘状态 !== '已落盘' && (
            <button className="link" type="button" onClick={props.onWriteback}>落盘回写</button>
          )}
          {role === '复核员' && hasBlockRecord && (
            <button className="link" type="button" onClick={props.onAck}>复核确认</button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="evidence-row">
          <td colSpan={13}>
            <div className="evidence-panel">
              <div className="evidence-meta">
                <span>数据凭据：{batch.数据凭据}</span>
                <span>复核依据：{batch.复核依据 || '—'}</span>
                <span>校验时间：{batch.校验时间}</span>
              </div>
              <h4>异常证据（{batch.异常证据.length} 条）</h4>
              {batch.异常证据.length > 0 ? (
                <table className="data-table sub-table">
                  <thead>
                    <tr><th>行号</th><th>校验项</th><th>异常原因</th><th>证据快照</th></tr>
                  </thead>
                  <tbody>
                    {batch.异常证据.map((item) => (
                      <tr key={item.行号}>
                        <td>{item.行号}</td>
                        <td>{item.校验项}</td>
                        <td>{item.异常原因}</td>
                        <td>{item.证据快照}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="hint-text">本批次样本未发现异常行</p>
              )}
              <h4>确认历史（{batch.确认历史.length} 条，重试保留上一份确认记录）</h4>
              <table className="data-table sub-table">
                <thead>
                  <tr><th>时间</th><th>操作人</th><th>动作</th><th>结论</th><th>依据</th></tr>
                </thead>
                <tbody>
                  {batch.确认历史.map((record, index) => (
                    <tr key={`${record.时间}-${index}`}>
                      <td>{record.时间}</td>
                      <td>{record.操作人}</td>
                      <td>{record.动作}</td>
                      <td>{record.结论}</td>
                      <td>{record.依据}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
