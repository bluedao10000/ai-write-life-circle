import { useState } from 'react'
import type { CreativeSettings } from '@writer-agent/contracts'
import { Btn, Choice, Dialog } from '../../components/vnext/ui'
import { ConsentFacts, ConsentList, ConsentTitle } from '../../components/vnext/ConsentFacts'
import { creativeApi } from '../../services/api/creativeApi'
import { creativeError } from './labels'

/** Book-level consent for organizing conversations into proposals. Shows exactly the server model. */
export default function CreativeConsent({
  bookId,
  settings,
  onClose,
  onEnabled,
}: {
  bookId: string
  settings: CreativeSettings
  onClose: () => void
  onEnabled: () => void
}) {
  const [auto, setAuto] = useState(true)
  const [budget, setBudget] = useState(Math.max(settings.reserveTokens * 20, 2000000))
  const [jobs, setJobs] = useState(200)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [key] = useState(() => crypto.randomUUID())
  const enable = async () => {
    setBusy(true)
    setError('')
    try {
      await creativeApi.settings(bookId, 'enable', { consent: true, model: settings.currentModel, dailyTokenBudget: budget, dailyJobBudget: jobs, autoOrganize: auto }, key)
      onEnabled()
    } catch (e) {
      setError(creativeError(e))
    } finally {
      setBusy(false)
    }
  }
  const m = settings.currentModel
  return (
    <Dialog
      title={<ConsentTitle>启用灵感整理</ConsentTitle>}
      label="启用灵感整理"
      size="lg"
      onClose={onClose}
      actions={
        <>
          <Btn onClick={onClose}>暂不启用</Btn>
          <Btn variant="primary" disabled={busy || !settings.available} onClick={() => void enable()}>
            同意以上范围并启用
          </Btn>
        </>
      }
    >
      <div className="space-y-4 text-ui-sm">
        {/* Plain facts first; endpoint and budgets stay available, folded, for authors who want them. */}
        <ConsentFacts rows={[['服务', `${m.provider} · ${m.execution === 'local' ? '本机' : '外部服务'}`], ['模型', m.model]]} />
        <p className="text-ink-2">{settings.disclosure}</p>
        <ConsentList title="会发送" kind="reads" items={['本轮作者消息与 AI 回复，以及最多 6 条近期消息', '已有创作设定的名称、别名与摘要', '计划核对时：目标章节已保存正文与该章规划']} />
        <ConsentList title="不会做" kind="never" items={['自动写入正式设定', '修改正文或发布作品', '读取其他作品']} />
        <Choice checked={auto} onChange={setAuto}>
          每轮对话完成后自动整理（关闭后只在你点击“整理本轮”时整理）
        </Choice>
        <details className="rounded-md border border-line-soft px-3 py-2">
          <summary className="cursor-pointer text-ink-3">技术细节与每日上限</summary>
          <div className="mt-3 space-y-3">
            <p className="break-all text-ink-3">接收地址：{m.endpoint}</p>
            <label className="block">
              每日 Token 上限（保守预留，每次约 {settings.reserveTokens}）
              <input aria-label="每日 Token 上限" type="number" min={settings.reserveTokens} max={100000000} value={budget} onChange={(e) => setBudget(Number(e.target.value))} className="mt-1 block w-48 rounded-md border border-line bg-transparent px-2 py-1" />
            </label>
            <label className="block">
              每日整理次数上限
              <input aria-label="每日整理次数上限" type="number" min={1} max={1000} value={jobs} onChange={(e) => setJobs(Number(e.target.value))} className="mt-1 block w-32 rounded-md border border-line bg-transparent px-2 py-1" />
            </label>
          </div>
        </details>
        {!settings.available && <p role="status" className="text-warn">服务端尚未配置模型，暂时无法启用。</p>}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
