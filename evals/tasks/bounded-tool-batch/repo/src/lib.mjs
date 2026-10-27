export function boundedToolBatch(requested, maximum = 16) { return Number.parseInt(requested, 10) || maximum; }
