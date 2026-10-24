export default function DesignNotes() {
  const sw = ['--bg', '--surface', '--surface-2', '--line', '--ink', '--ink-2', '--ink-3', '--accent', '--warn', '--danger', '--ok']
  const sec = 'rounded-xl border p-6'
  return (
    <div className="mx-auto max-w-[1100px] space-y-6 px-8 py-10 text-[13px]" style={{ color: 'var(--ink-2)' }}>
      <h2 className="font-prose text-2xl font-semibold" style={{ color: 'var(--ink)' }}>设计说明</h2>
      <section className={sec} style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <h3 className="mb-3 font-medium" style={{ color: 'var(--ink)' }}>信息架构</h3>
        <div className="grid grid-cols-3 gap-4 leading-relaxed">
          {[
            ['创作总览', '进度 · 当前章节 · 未解决问题 · 待确认建议'],
            ['沉浸式写作', '章节导航 · 正文编辑 · AI 协作面板（审查/对话/研究）'],
            ['作品知识库', '世界观 · 人物档案 · 关系图 · 全局设定搜索'],
            ['故事结构', '主线/支线 · 时间线 · 伏笔追踪 · 人物弧光'],
            ['Agent 工作台', '自由对话 · 文学研究 · 思想推演 · 连续性审查'],
            ['提案与决策', '建议队列 · 证据 · Diff · 接受/拒绝/暂缓 · 决策日志'],
          ].map(([a, b]) => (
            <div key={a}><div style={{ color: 'var(--ink)' }}>{a}</div>{b}</div>
          ))}
        </div>
      </section>
      <section className={sec} style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <h3 className="mb-3 font-medium" style={{ color: 'var(--ink)' }}>设计系统</h3>
        <div className="flex flex-wrap gap-3">
          {sw.map((s) => (
            <div key={s} className="w-24">
              <div className="h-12 rounded-md border" style={{ background: `var(${s})`, borderColor: 'var(--line)' }} />
              <div className="mt-1 font-mono text-[11px]">{s}</div>
            </div>
          ))}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-6 leading-relaxed">
          <div><b style={{ color: 'var(--ink)' }}>排版</b><br />正文 Noto Serif SC 17/35（行高 2.05），首行缩进 2em，栏宽 680px；界面 Inter + 苹方 13/20；标题 28 Semibold。</div>
          <div><b style={{ color: 'var(--ink)' }}>间距 / 圆角 / 阴影</b><br />4px 基准网格（4·8·12·16·24·40·64）；圆角 4 标签 · 6 按钮 · 8 卡片 · 12 容器；仅一级阴影 --shadow，用于激活态。</div>
          <div><b style={{ color: 'var(--ink)' }}>语义色</b><br />红=连续性冲突，靛蓝=创作启发，绿=研究/接受，琥珀=待确认。颜色只用于状态，不做装饰。</div>
          <div><b style={{ color: 'var(--ink)' }}>布局</b><br />1440 基准：左 248 / 中 自适应（正文 680 居中）/ 右 380 可折叠。</div>
        </div>
      </section>
      <section className={sec} style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <h3 className="mb-3 font-medium" style={{ color: 'var(--ink)' }}>关键交互</h3>
        <ol className="list-decimal space-y-1.5 pl-5 leading-relaxed">
          <li>Agent 后台审查时，面板顶部显示呼吸点与当前任务，不打断写作。</li>
          <li>发现问题：正文左侧出现语义色圆点，冲突文字加波浪下划线；点击圆点或卡片双向联动高亮段落。</li>
          <li>卡片展开显示分析 → 证据（来源可跳转）→ Diff 提案。</li>
          <li>AI 无写权限：仅“接受修改”后才写入正文，并记入决策日志；拒绝/暂缓归档至「提案与决策」。</li>
          <li>对话中 Agent 可提出反对意见，但始终以“由你决定”收尾，并附引用来源。</li>
          <li>快捷键：⌘\ 右侧面板 · ⌘⇧\ 左侧导航 · ⌘⇧F 专注模式 · ⌘⇧R 开始审查 · ⌘S 立即保存 · ⌘Z/⌘⇧Z 撤销重做 · Esc 关闭抽屉。</li>
        </ol>
      </section>
      <section className={sec} style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <h3 className="mb-3 font-medium" style={{ color: 'var(--ink)' }}>React + TypeScript 实现</h3>
        <div className="grid grid-cols-2 gap-2 leading-relaxed">
          <div>三栏布局 → React 组件 + Tailwind CSS + 可拖拽分隔</div>
          <div>章节目录 → 受控组件与章节数据 props</div>
          <div>面板标签 → React 状态驱动的 ARIA tabs</div>
          <div>问题卡片 → React 组件与提案状态</div>
          <div>标签 → 语义色 Design Tokens</div>
          <div>正文编辑 → TipTap React + ProseMirror Decoration 标注</div>
          <div>主题 → CSS variables 与 .dark 切换</div>
          <div>确认操作 → 受控确认对话框</div>
        </div>
      </section>
    </div>
  )
}
