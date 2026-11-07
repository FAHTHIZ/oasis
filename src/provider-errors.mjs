// Shared provider failure formatting for the CLI runtime and browser application.

export function briefFailure(message, status = 0) {
  let text = String(message || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^Model provider returned HTTP \d+:\s*/i, '').replace(/\.?\s*Check the configured [^.]*\.?$/i, '');
  const retry = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(text);
  const parts = retry ? [retry[1] && retry[1] + 'h', retry[2] && retry[2] + 'm', !retry[1] && retry[3] && Math.ceil(Number(retry[3])) + 's'].filter(Boolean) : [];
  const when = parts.length ? ' (retry in ' + parts.join('') + ')' : '';
  const freeTier = /free.?tier/i.test(text) ? 'free-tier ' : '';
  if (/per ?day|PerDay/i.test(text) && /quota|limit/i.test(text)) return 'daily ' + freeTier + 'quota used up' + when;
  if (/per ?minute|PerMinute/i.test(text) && /quota|limit/i.test(text)) return 'per-minute rate limit' + when;
  if (/limit: ?0\b/i.test(text) && /quota/i.test(text)) return 'this key has no ' + freeTier + 'quota for this model';
  if (/no longer available|deprecated|decommissioned|retired/i.test(text)) return 'model retired by the provider';
  if (/high demand|overloaded|temporarily unavailable/i.test(text)) return 'busy right now' + when;
  const code = Number(status) || 0;
  return (code && !/\(\d{3}\)/.test(text) ? 'HTTP ' + code + ': ' : '') + text.split(/(?<=[.!?])\s/)[0].slice(0, 140);
}
