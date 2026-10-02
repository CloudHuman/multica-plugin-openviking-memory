import { JobQueue } from './queue.mjs';
import { makeArchiveHandler } from './pipeline.mjs';
import { ExtractionWatcher } from './extraction-watch.mjs';

/** Load extraction pins before journal replay can compact completed jobs. */
export function createArchiveProcessing({ ov, registry, statusLog, cfg, memoryRules = null, log = () => {}, queueOptions = {} }) {
  const extractions = new ExtractionWatcher({ ov, registry, statusLog, stateDir: cfg.stateDir, cfg, log });
  const queue = new JobQueue({
    stateDir: cfg.stateDir,
    handler: makeArchiveHandler({ ov, registry, statusLog, extractions, cfg, memoryRules, log }),
    maxAttempts: cfg.queueMaxAttempts,
    baseDelayMs: cfg.queueBaseDelayMs,
    log,
    ...queueOptions,
    isPinned: (id) => extractions.isPinned(id),
  });
  extractions.queue = queue;
  return { queue, extractions };
}
