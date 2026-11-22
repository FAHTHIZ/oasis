// Per-turn step and tool-call limits. A leaf module (no imports) so config.mjs
// can read them without loading model-budgets.mjs, which needs the model
// catalog, which needs config.mjs (a load-time import cycle).
export const MAX_TURN_TOOL_CALLS = 2000;
// Model requests per user turn. 60 stopped real refactors halfway (Claude
// Code and Codex have no step cap); the token and tool-call budgets still
// bound a runaway turn.
export const DEFAULT_TURN_STEPS = 150;
export const MAX_TURN_STEPS = 1000;
export const DEFAULT_TURN_TOOL_CALLS = 600;
