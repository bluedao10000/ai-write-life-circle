import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  assertIndependentNovelAnalysisDatasets,
  gradeNovelAnalysisCase,
  judgeNovelAnalysisCase,
  novelAnalysisJudgeRequest,
  parseNovelAnalysisDataset,
  type NovelAnalysisDataset,
} from '../src/evaluation/novel-analysis.js';

const chapters = [{chapterId: 'CH-000001', title: '雨夜', markdown: '林舟是医师。他在雨夜回到临安。'}];
const validOutput = {
  findings: [
    {
      kind: 'character',
      title: '林舟身份',
      statement: '林舟是医师。',
      confidence: 0.9,
      evidence: [{chapterId: 'CH-000001', quote: '林舟是医师。'}],
    },
  ],
  entities: [{kind: 'character', name: '林舟'}],
};
const dataset = (split: 'dev' | 'held-out', caseId: string, output: unknown = validOutput): NovelAnalysisDataset =>
  parseNovelAnalysisDataset({
    version: `novel-analysis-${split}-v1`,
    split,
    synthetic: true,
    cases: [
      {
        caseId,
        phase: 'chapters',
        chapters,
        output,
        expected: {mustGroundQuotes: ['林舟是医师。'], maxFindings: 5, conflictKinds: []},
      },
    ],
  });

test('Deterministic grader accepts grounded candidates and rejects ungrounded quotes', () => {
  const item = dataset('dev', 'dev-grounded').cases[0];
  assert.equal(gradeNovelAnalysisCase(item).passed, true);
  const ungrounded = dataset('dev', 'dev-ungrounded', {
    ...validOutput,
    findings: [{...validOutput.findings[0], evidence: [{chapterId: 'CH-000001', quote: '正文里没有这句话。'}]}],
  }).cases[0];
  const grade = gradeNovelAnalysisCase(ungrounded);
  assert.equal(grade.passed, false);
  assert.equal(grade.checks.evidenceGrounded, false);
  assert.match(grade.issues.join(','), /UNGROUNDED_QUOTE/);
  const malformed = dataset('dev', 'dev-malformed', {...validOutput, findings: [{...validOutput.findings[0], confidence: 2}]}).cases[0];
  assert.equal(gradeNovelAnalysisCase(malformed).issues[0], 'SCHEMA_INVALID');
});

test('Dev and held-out datasets cannot share cases or content', () => {
  const dev = dataset('dev', 'shared-case');
  const held = dataset('held-out', 'shared-case');
  assert.throws(() => assertIndependentNovelAnalysisDatasets(dev, held), /CONTAMINATION/);
  assert.throws(() => parseNovelAnalysisDataset({...dev, cases: [dev.cases[0], dev.cases[0]]}), /DUPLICATE_NOVEL_ANALYSIS_CASE/);
});

test('Judge request is bounded and its verdict never replaces the deterministic grade', async () => {
  const item = dataset('dev', 'dev-judge').cases[0];
  const request = novelAnalysisJudgeRequest(item);
  assert.match(request.system, /novel-analysis-judge-v1/);
  assert.match(request.input, /林舟是医师/);
  const judged = await judgeNovelAnalysisCase(item, async () =>
    JSON.stringify({rubricVersion: 'novel-analysis-judge-v1', scores: {evidence: 4, restraint: 3, usefulness: 3}, rationale: '引文一致。'}),
  );
  assert.equal(judged.score, 10 / 3);
  assert.equal(gradeNovelAnalysisCase(item).passed, true);
});
