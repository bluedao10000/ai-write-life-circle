import { describe, expect, it } from 'vitest'
import { revisionDiff } from '../features/workspace/revisionDiff'
describe('bounded revision diff', () => {
 it('labels additions, deletions and changes in historical-to-current order', () => {
  const values=revisionDiff('一\n旧\n尾\n','一\n新\n尾\n追加\n')!
  expect(values.map((x)=>x.kind)).toEqual(['未变','修改前','修改后','未变','新增'])
  expect(revisionDiff('删除\n','')?.[0]?.kind).toBe('删除')
 })
 it('avoids unbounded comparison of long chapters', () => {
  expect(revisionDiff('长'.repeat(300001),'新')).toBeNull()
 })
})
