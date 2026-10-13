export function estimateRemainingSeconds({ processed, total, elapsedMs }) {
  if (![processed, total, elapsedMs].every(Number.isFinite)) return null;
  if (total <= 0 || processed >= total) return 0;
  if (processed <= 0 || elapsedMs <= 0) return null;
  return Math.max(1, Math.ceil((elapsedMs / processed) * (total - processed) / 1000));
}

export function formatEstimatedTime(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return "Calculating after the first completed batch…";
  if (seconds <= 0) return "Complete";
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  if (hours > 0) return `About ${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `About ${minutes}m ${Math.floor(seconds % 60)}s`;
  return `About ${Math.max(1, Math.ceil(seconds))}s`;
}
