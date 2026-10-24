import { workspaceSnapshotSchema, type Chapter, type WorkspaceSnapshot, type WorkspaceV04, type ChapterListV04 } from '@writer-agent/contracts'

const defaultLayout = { leftOpen: false, rightOpen: false, leftW: 280, rightW: 360, focus: false }

/** Convert V0.4 workspace and chapter-tree DTOs into the existing UI model. */
export function mapWorkspaceToStudio(workspace: WorkspaceV04, chapterList: ChapterListV04): WorkspaceSnapshot {
  const chapters: Chapter[] = []
  for (const volume of chapterList.volumes) {
    const volumeLabel = volume.title?.trim() || volume.volumeId?.trim() || '未分卷'
    for (const item of volume.chapters ?? []) {
      if (!item.chapterId?.trim() || !item.title?.trim()) {
        throw new Error('章节目录缺少稳定 chapterId 或标题，已停止加载。')
      }
      chapters.push({
        id: item.chapterId,
        volume: volumeLabel,
        title: item.title,
        meta: item.meta ?? '',
        ...(item.wordCount !== undefined ? { wordCount: item.wordCount } : {}),
      })
    }
  }

  const savedChapter = workspace.userState.lastChapterId
  const currentChapterId = savedChapter && chapters.some((chapter) => chapter.id === savedChapter)
    ? savedChapter
    : chapters[0]?.id ?? ''
  const storedLayout = workspace.userState.layout

  return workspaceSnapshotSchema.parse({
    capabilities: workspace.capabilities,
    projectId: workspace.project.projectId ?? '',
    projectTitle: workspace.project.title?.trim() || '本地作品',
    chapters,
    knowledge: [],
    // Chapter bodies are fetched on selection, never inferred from Demo data.
    document: {},
    markdownByChapter: {},
    preferences: {
      ...(workspace.userState.lastView ? { lastView: workspace.userState.lastView } : {}),
      ...(savedChapter ? { lastChapterId: savedChapter } : {}),
      ...(storedLayout ? { layout: { ...defaultLayout, ...storedLayout } } : {}),
      theme: workspace.userState.theme ?? 'light',
    },
    chapterVersions: {},
    proposals: [],
    decisions: [],
    chat: [],
    challenge: [],
    sequence: 0,
    currentChapterId,
  })
}
