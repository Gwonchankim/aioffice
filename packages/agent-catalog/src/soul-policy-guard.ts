/**
 * Guards SOUL.MD bodies against instructions that weaken the Orion Console
 * common operating principles, approval gates, or CLI safety flags, per the
 * Orion Console Agent Profile Format Specification §6 "금지 사항" list.
 */
export class SoulPolicyViolationError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`SOUL policy violation(s) detected: ${reasons.join('; ')}`);
    this.name = 'SoulPolicyViolationError';
    this.reasons = reasons;
  }
}

interface ForbiddenPattern {
  readonly pattern: RegExp;
  readonly reason: string;
}

const forbiddenPatterns: readonly ForbiddenPattern[] = [
  {
    pattern: /--dangerously|bypass-approvals|skip-permissions|--skip-git-repo-check/i,
    reason: 'References a CLI approval-bypass or permission-skipping flag.',
  },
  {
    pattern: /(정책|승인|권한|등급)\s*(을|를)?\s*(무시|우회)(?!하지)/,
    reason: 'Instructs ignoring or bypassing policy, approval, permission, or classification.',
  },
  {
    pattern: /승인\s*없이[^.\n]{0,30}(해도 된다|할 수 있다|실행한다)/,
    reason: 'Authorizes an external action to proceed without approval.',
  },
];

/**
 * Throws `SoulPolicyViolationError` (with every matched reason) when the
 * given SOUL.MD body contains a forbidden instruction. Negated statements
 * (e.g. "...하지 않는다") are intentionally excluded from every pattern above
 * and therefore pass.
 */
export function assertSoulPolicyCompliant(soul: string): void {
  const reasons: string[] = [];
  for (const { pattern, reason } of forbiddenPatterns) {
    if (pattern.test(soul)) {
      reasons.push(reason);
    }
  }
  if (reasons.length > 0) {
    throw new SoulPolicyViolationError(reasons);
  }
}
