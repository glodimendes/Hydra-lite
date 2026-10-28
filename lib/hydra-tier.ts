/**
 * Hydra Lite deterministic Codex routing tier.
 *
 * Per docs/plan/hydra-lite-macos-plan.md: "Codex routing is deterministic
 * and local: low, balanced, and high, with a per-task auto|low|balanced|high
 * override. Edit tasks cannot use a tier below balanced." This is
 * intentionally a pure lookup, not a scoring/routing system — Hydra Lite has
 * exactly one agent (Codex), so there is nothing to route *between*, only a
 * tier to pick.
 */

export type HydraLiteTier = 'low' | 'balanced' | 'high';
export type TaskEffect = 'read' | 'edit';
export type TierOverride = 'auto' | HydraLiteTier;

const TIER_ORDER: readonly HydraLiteTier[] = ['low', 'balanced', 'high'];
const MIN_EDIT_TIER: HydraLiteTier = 'balanced';

function tierIndex(tier: HydraLiteTier): number {
  return TIER_ORDER.indexOf(tier);
}

/**
 * Resolve the tier for a task given its effect and an optional per-task
 * override. Reads default to 'low' when no override is given. Edit tasks
 * are floored at 'balanced' regardless of override (an override of 'low' on
 * an edit task is raised to 'balanced', never rejected).
 */
export function resolveTier(effect: TaskEffect, override: TierOverride = 'auto'): HydraLiteTier {
  const requested: HydraLiteTier = override === 'auto' ? 'low' : override;
  if (effect !== 'edit') return requested;
  return tierIndex(requested) >= tierIndex(MIN_EDIT_TIER) ? requested : MIN_EDIT_TIER;
}

/**
 * Map a Hydra Lite tier onto Codex's existing reasoningEffort vocabulary
 * (lib/hydra-agents.ts getReasoningEffort/setReasoningEffort), for later
 * wiring once edit execution invokes Codex. Not consumed this milestone —
 * only the read path (invoke.nonInteractive, which does not take a
 * reasoningEffort argument today) runs.
 */
export function tierToReasoningEffort(tier: HydraLiteTier): 'low' | 'medium' | 'high' {
  switch (tier) {
    case 'low':
      return 'low';
    case 'balanced':
      return 'medium';
    case 'high':
      return 'high';
  }
}
