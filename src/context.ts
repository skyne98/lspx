export type ContextSection = "containers" | "calls" | "types" | "diagnostics";

export interface ContextCandidate<T = unknown> {
  key: string;
  section: ContextSection;
  priority: number;
  content: string;
  value: T;
}

export interface PackedContext<TTarget = unknown> {
  target: TTarget & { source: string; truncated?: boolean; omittedCharacters?: number };
  included: Record<ContextSection, unknown[]>;
  omitted: Record<ContextSection, number> & { total: number };
  budget: { limit: number; used: number; remaining: number; unit: "content-characters" };
}

/** Deterministically rank, deduplicate, and budget semantic context. Metadata
 *  is free; the budget counts source/signature/message characters that consume
 *  model context. The target is always first and is the only entry that may be
 *  explicitly truncated. */
export function packContext<TTarget extends { source: string }>(
  target: TTarget,
  candidates: ContextCandidate[],
  requestedBudget: number,
): PackedContext<TTarget> {
  const limit = Math.max(256, Math.floor(requestedBudget));
  const targetChars = Math.min(target.source.length, limit);
  const packedTarget = {
    ...target,
    source: target.source.slice(0, targetChars),
    ...(targetChars < target.source.length
      ? { truncated: true as const, omittedCharacters: target.source.length - targetChars }
      : {}),
  };
  let used = targetChars;
  const included: Record<ContextSection, unknown[]> = {
    containers: [], calls: [], types: [], diagnostics: [],
  };
  const omitted: Record<ContextSection, number> & { total: number } = {
    containers: 0, calls: 0, types: 0, diagnostics: 0, total: 0,
  };
  const seen = new Set<string>();
  const ranked = [...candidates].sort(
    (a, b) => a.priority - b.priority || a.key.localeCompare(b.key),
  );
  for (const candidate of ranked) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    const cost = candidate.content.length;
    if (used + cost <= limit) {
      included[candidate.section].push(candidate.value);
      used += cost;
    } else {
      omitted[candidate.section]++;
      omitted.total++;
    }
  }
  return {
    target: packedTarget,
    included,
    omitted,
    budget: { limit, used, remaining: limit - used, unit: "content-characters" },
  };
}
