// 本作品的 AI 资料范围: the only data authorization in 灵感. Ordinary chat needs
// none — it sends only the author's messages and this conversation. Each scope
// is an explicit, revocable per-work grant stored by the server (Go re-signs
// the capability for every turn and revokes old grants on change).
import { useState } from 'react'
import type { ThinkingSession } from '@writer-agent/contracts'
import { Btn, Choice, Dialog } from '../../components/vnext/ui'

type Scope = ThinkingSession['scopes'][number]
const rows: { key: Scope; label: string; hint: string }[] = [
  { key: 'chapters', label: '本作品已保存章节', hint: '讨论需要时按段读取，并附上可核对的原文。' },
  { key: 'knowledge', label: '本作品知识库', hint: '从已保存章节整理的人物、地点与时间线。' },
  { key: 'creative', label: '创作设定与待确认候选', hint: '已确认设定、草稿与候选会被区分对待。' },
  { key: 'notes', label: '私人作者笔记（额外授权）', hint: '你的私人笔记。只有单独勾选才会读取。' },
]
export const scopeSummary = (scopes: Scope[]) => (scopes.length ? `已开启 ${scopes.length} 项作品资料` : '仅限对话内容')

export default function ScopeDialog({ scopes, onSave, onClose }: { scopes: Scope[]; onSave: (next: Scope[]) => Promise<boolean>; onClose: () => void }) {
  const [next, setNext] = useState<Scope[]>(scopes)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      title="本作品的 AI 资料范围"
      label="本作品的 AI 资料范围"
      onClose={onClose}
      actions={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const ok = await onSave(next)
              setBusy(false)
              if (ok) onClose()
            }}
          >
            保存范围
          </Btn>
        </>
      }
    >
      <p className="mb-4 text-ui-sm text-ink-2">选择讨论时可以参考的资料。分析本书人物或情节时，请开启已保存章节；章节查阅不依赖知识库整理是否完成。</p>
      <div className="space-y-3">
        {rows.map((r) => (
          <Choice key={r.key} checked={next.includes(r.key)} onChange={(on) => setNext((old) => (on ? [...old.filter((s) => s !== r.key), r.key] : old.filter((s) => s !== r.key)))}>
            <span className="block text-ui text-ink">{r.label}</span>
            <span className="block text-ui-sm text-ink-3">{r.hint}</span>
          </Choice>
        ))}
      </div>
      <p className="mt-4 text-micro text-ink-3">范围按作品保存，随时可以关闭；关闭会停止仍在读取资料的回复。</p>
    </Dialog>
  )
}
