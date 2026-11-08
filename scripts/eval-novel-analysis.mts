// Deterministic evaluation for the novel intelligence pipeline. Recorded
// candidate outputs are graded against synthetic chapters; the optional judge
// and human review stay calibration aids, never ground truth.
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  assertIndependentNovelAnalysisDatasets,
  gradeNovelAnalysisDataset,
  loadNovelAnalysisDataset,
  novelAnalysisReviewSheet,
} from '../apps/agent/src/evaluation/novel-analysis.js';

const root = new URL('../harness/evals/novel-analysis/', import.meta.url);
const dev = loadNovelAnalysisDataset(fileURLToPath(new URL('dev.json', root)));
const held = loadNovelAnalysisDataset(fileURLToPath(new URL('held-out.json', root)));
assertIndependentNovelAnalysisDatasets(dev, held);
const datasets = [gradeNovelAnalysisDataset(dev), gradeNovelAnalysisDataset(held)];
const report = {
  generatedAt: new Date().toISOString(),
  mode: 'deterministic-recorded-outputs',
  modelCalls: 0,
  judge: 'not_run',
  humanReview: 'pending',
  datasets,
};
writeFileSync(new URL('report.json', root), JSON.stringify(report, null, 2) + '\n');
if (process.argv.includes('--review-sheet')) {
  writeFileSync(new URL('review.md', root), novelAnalysisReviewSheet([dev, held]));
}
for (const dataset of datasets) {
  console.log(`${dataset.split} ${dataset.version}: ${dataset.passed}/${dataset.total} cases passed`);
  for (const item of dataset.cases) if (!item.passed) console.log(`  ${item.caseId}: ${item.issues.join(', ')}`);
}
if (datasets.some((dataset) => dataset.passed !== dataset.total)) process.exit(1);
