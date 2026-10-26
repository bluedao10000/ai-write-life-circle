import { afterEach, expect, it, vi } from 'vitest'
import { emitAuthorMetric, installAuthorMetricSink, recordTimeToWriting } from '../observability/authorExperience'
afterEach(()=>installAuthorMetricSink())
it('records only aggregate names and coarse values, even if runtime includes private fields',()=>{
 const sink=vi.fn();installAuthorMetricSink(sink)
 emitAuthorMetric({event:'revision_recovery',bucket:'success',prose:'must be dropped',userId:'private'} as never)
 expect(sink).toHaveBeenCalledWith({event:'revision_recovery',bucket:'success'})
 recordTimeToWriting(11000)
 expect(sink).toHaveBeenLastCalledWith({event:'time_to_writing',bucket:'5_to_15s'})
 emitAuthorMetric({event:'unknown',bucket:'user text'} as never)
 expect(sink).toHaveBeenCalledTimes(2)
})
it('metrics are off by default and sink failures cannot interrupt writing',()=>{
 expect(()=>recordTimeToWriting(100)).not.toThrow()
 installAuthorMetricSink(()=>{throw Error('transport failure')})
 expect(()=>recordTimeToWriting(200)).not.toThrow()
})
