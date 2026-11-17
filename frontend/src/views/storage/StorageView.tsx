import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { listIsolationRows, listLedgerRows } from '@/api/validation-service'
import type { EntryRow } from '@/data/types'
import type { IsolationRow, LedgerRow } from '@/data/validation'

const meta = moduleMeta('storage')
const columns = [
  "配置编号",
  "存储类型",
  "输出路径",
  "文件格式",
  "分区策略",
  "压缩算法",
  "保留天数",
  "覆写模式"
]
const actions = [
  "提交校验",
  "启用配置",
  "停用配置"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]
const stats = [
  {
    "label": "存储配置总数",
    "value": 0
  },
  {
    "label": "已启用配置",
    "value": 0
  },
  {
    "label": "待校验配置",
    "value": 0
  }
]

export default function StorageView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [isolation, setIsolation] = useState<IsolationRow[]>([])
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setLedger(listLedgerRows())
      setIsolation(listIsolationRows())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据落盘列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  return (
    <section className="page" data-module="storage">
      <header className="page-head">
        <div>
          <h2>数据落盘管理</h2>
          <p className="page-desc">维护数据落盘配置的输入、执行约束与结果记录，为数据落盘提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('存储配置登记入口尚未接入审批流')}>
            登记存储配置
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出数据落盘清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无数据落盘数据，可先登记存储配置</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条数据落盘记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>

      <section className="exec-panel">
        <header className="page-head">
          <div>
            <h3>落盘清单（待处理区）</h3>
            <p className="page-desc">
              数据落盘只接收结果校验批次明细中已通过的数据行，跟随批次结论联动；
              完成数据落库后批次保留原采样状态。
            </p>
          </div>
          <div className="page-actions">
            <button className="btn" type="button" onClick={reload}>刷新清单</button>
          </div>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>清单编号</th>
              <th>来源批次</th>
              <th>规则编号</th>
              <th>通过行数</th>
              <th>存储配置</th>
              <th>落盘时间</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((row) => (
              <tr key={row.清单编号}>
                <td>{row.清单编号}</td>
                <td>{row.来源批次}</td>
                <td>{row.规则编号}</td>
                <td>{row.通过行数}</td>
                <td>{row.存储配置}</td>
                <td>{row.落盘时间}</td>
                <td><span className={row.状态 === '已落盘' ? 'badge ok' : 'badge block'}>{row.状态}</span></td>
              </tr>
            ))}
            {ledger.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={7}>暂无落盘记录，请在结果校验页对通过的批次执行落盘回写</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="exec-panel">
        <header className="page-head">
          <div>
            <h3>隔离区</h3>
            <p className="page-desc">未决或阻断的校验批次数据行保留在隔离区等待复核，不进入落盘清单。</p>
          </div>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>行号</th>
              <th>来源批次</th>
              <th>采集批次</th>
              <th>异常原因</th>
              <th>隔离原因</th>
              <th>状态</th>
              <th>入区时间</th>
            </tr>
          </thead>
          <tbody>
            {isolation.map((row) => (
              <tr key={`${row.来源批次}-${row.行号}`}>
                <td>{row.行号}</td>
                <td>{row.来源批次}</td>
                <td>{row.采集批次}</td>
                <td>{row.异常原因 || '—'}</td>
                <td>{row.隔离原因}</td>
                <td><span className="badge pending">{row.状态}</span></td>
                <td>{row.入区时间}</td>
              </tr>
            ))}
            {isolation.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={7}>隔离区为空，没有等待复核的记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </section>
  )
}
