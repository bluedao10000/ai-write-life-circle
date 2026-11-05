import { useState } from 'react'
import type { CreativeSettings } from '@writer-agent/contracts'
import { Btn, Choice, Dialog } from '../../components/vnext/ui'
import { ConsentFacts, ConsentTitle } from '../../components/vnext/ConsentFacts'
import { creativeApi } from '../../services/api/creativeApi'
import { creativeError } from './labels'

/** Book-level settings for organizing conversations into proposals. */
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
  const [orchestrated, setOrchestrated] = useState(settings.multiAgentPlanCheck)
  const [memory, setMemory] = useState(settings.autoMemoryConsolidation)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [key] = useState(() => crypto.randomUUID())
  const enable = async () => {
    setBusy(true)
    setError('')
    try {
      await creativeApi.settings(bookId, 'enable', { consent: true, model: settings.currentModel, dailyTokenBudget: settings.dailyTokenBudget || 100000000, dailyJobBudget: settings.dailyJobBudget || 200, autoOrganize: auto, multiAgentPlanCheck: orchestrated, autoMemoryConsolidation: memory }, key)
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
            启用灵感整理
          </Btn>
        </>
      }
    >
      <div className="space-y-4 text-ui-sm">
        <ConsentFacts rows={[['服务', `${m.provider} · ${m.execution === 'local' ? '本机' : '外部服务'}`], ['模型', m.model]]} />
        <p className="text-ink-2">{settings.disclosure}</p>
        <Choice checked={auto} onChange={setAuto}>
          每轮对话完成后自动整理（关闭后只在你点击“整理本轮”时整理）
        </Choice>
        <Choice checked={orchestrated} onChange={setOrchestrated}>
          计划核对使用五个只读步骤（更高费用；不开放工具，也不会写入正文或正式设定）
        </Choice>
        <Choice checked={memory} onChange={setMemory}>
          后台整理已完成任务的执行经验（读取同类来源并生成待审核候选，不会自动确认）
        </Choice>
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
