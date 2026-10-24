import {
  userWorkspaceStateV04Schema,
  workspaceV04Schema,
  type UserWorkspaceStateV04,
} from '@writer-agent/contracts'
import { getJson, patchJson } from './client'

const workspacePath = (projectId: string) => `/v1/projects/${encodeURIComponent(projectId)}/workspace`

export async function getWorkspace(projectId: string) {
  return workspaceV04Schema.parse(await getJson(workspacePath(projectId)))
}

export async function patchWorkspace(projectId: string, state: UserWorkspaceStateV04) {
  const request = userWorkspaceStateV04Schema.parse(state)
  return userWorkspaceStateV04Schema.parse(await patchJson(workspacePath(projectId), request))
}
