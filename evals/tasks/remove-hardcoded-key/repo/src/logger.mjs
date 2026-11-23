import { config } from './config.mjs';

// Prints the active configuration at start-up.
export function describeConfig(cfg = config) {
  return 'config ' + JSON.stringify(cfg);
}
