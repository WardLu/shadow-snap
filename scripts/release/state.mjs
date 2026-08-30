export const RELEASE_STATES = Object.freeze([
  'admission_ready',
  'admitted',
  'adopt_intent',
  'adopted',
  'initialize_intent',
  'initialized',
  'initialized_expired',
  'stage_intent',
  'staged_pending_promote',
  'staged_expired',
  'promote_intent',
  'rollback_intent',
  'current',
  'stage_failed',
  'rolled_back',
  'recovery_admitted',
  'renew_intent',
  'fail_intent',
]);

const STATE_SET = new Set(RELEASE_STATES);
const EVIDENCE_GRAPH = new Map([
  ['admission_ready', new Set(['admitted'])],
  ['admitted', new Set(['adopt_intent', 'initialize_intent', 'stage_intent', 'recovery_admitted'])],
  ['adopt_intent', new Set(['adopted'])],
  ['adopted', new Set(['stage_intent'])],
  ['initialize_intent', new Set(['initialized'])],
  ['initialized', new Set(['stage_intent', 'renew_intent'])],
  ['stage_intent', new Set(['staged_pending_promote', 'stage_failed'])],
  ['staged_pending_promote', new Set(['promote_intent', 'fail_intent', 'renew_intent'])],
  ['promote_intent', new Set(['current'])],
  ['current', new Set(['stage_intent', 'rollback_intent'])],
  ['rollback_intent', new Set(['rolled_back'])],
  ['recovery_admitted', new Set(['stage_intent'])],
  ['renew_intent', new Set(['initialized', 'staged_pending_promote'])],
  ['fail_intent', new Set(['stage_failed'])],
]);

const OPERATIONS = new Map([
  ['admission_ready', new Set(['publish'])],
  ['admitted', new Set(['adopt', 'initialize', 'stage', 'recover'])],
  ['adopt_intent', new Set(['resume'])],
  ['adopted', new Set(['stage'])],
  ['initialize_intent', new Set(['resume'])],
  ['initialized', new Set(['stage', 'expire'])],
  ['initialized_expired', new Set(['renew'])],
  ['stage_intent', new Set(['resume'])],
  ['staged_pending_promote', new Set(['promote', 'fail', 'expire'])],
  ['staged_expired', new Set(['renew', 'fail'])],
  ['promote_intent', new Set(['resume'])],
  ['rollback_intent', new Set(['resume'])],
  ['current', new Set(['stage', 'rollback'])],
  ['stage_failed', new Set(['recover'])],
  ['rolled_back', new Set(['recover'])],
  ['recovery_admitted', new Set(['stage'])],
]);

function freeze(reasonCode) {
  return { action: 'freeze', reasonCode };
}

export function validateTransition({ from, operation, facts }) {
  if (!STATE_SET.has(from) || typeof operation !== 'string' || !facts || typeof facts !== 'object') {
    return { allowed: false, reasonCode: 'transition_input_invalid' };
  }
  if (!OPERATIONS.get(from)?.has(operation)) {
    return { allowed: false, reasonCode: 'transition_forbidden' };
  }
  return { allowed: true, reasonCode: 'transition_allowed' };
}

export function deriveReleaseState(snapshot, now = new Date()) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.evidence)) {
    return { state: 'drift_freeze', reasonCode: 'state_snapshot_invalid' };
  }
  if (!Number.isInteger(snapshot.pendingTtlSeconds) || snapshot.pendingTtlSeconds < 60) {
    return { state: 'drift_freeze', reasonCode: 'state_ttl_invalid' };
  }
  if (!snapshot.releasePublished) {
    return snapshot.evidence.length === 0
      ? { state: 'admission_ready', reasonCode: 'release_not_published' }
      : { state: 'drift_freeze', reasonCode: 'evidence_before_release_publish' };
  }
  if (snapshot.evidence.length === 0) {
    return { state: 'drift_freeze', reasonCode: 'published_release_missing_evidence' };
  }

  let current = 'admission_ready';
  let previousTime = -Infinity;
  let lastEvidence;
  for (const evidence of snapshot.evidence) {
    const createdAt = Date.parse(evidence?.createdAt);
    if (
      !STATE_SET.has(evidence?.state) ||
      evidence.fromState !== current ||
      !Number.isFinite(createdAt) ||
      createdAt <= previousTime ||
      !EVIDENCE_GRAPH.get(current)?.has(evidence.state)
    ) {
      return { state: 'drift_freeze', reasonCode: 'evidence_chain_invalid' };
    }
    current = evidence.state;
    previousTime = createdAt;
    lastEvidence = evidence;
  }

  const ageMs = now.getTime() - previousTime;
  const expired = ageMs > snapshot.pendingTtlSeconds * 1000;
  if (expired && current === 'initialized') {
    return { state: 'initialized_expired', reasonCode: 'initialized_window_expired' };
  }
  if (expired && current === 'staged_pending_promote') {
    return { state: 'staged_expired', reasonCode: 'staged_window_expired' };
  }
  return {
    state: current,
    reasonCode: 'evidence_chain_valid',
    evidenceCount: snapshot.evidence.length,
    lastEvidence,
  };
}

function assertIntentFacts(intent, facts) {
  for (const key of ['repository', 'tag', 'targetSha', 'configHash']) {
    if (intent[key] !== facts[key]) return `${key}_mismatch`;
  }
  return null;
}

export function reconcileIntent({ intent, facts }) {
  if (!intent || typeof intent !== 'object' || !facts || typeof facts !== 'object') {
    return freeze('intent_facts_invalid');
  }
  const mismatch = assertIntentFacts(intent, facts);
  if (mismatch) return freeze(mismatch);
  if (
    typeof facts.state !== 'string' ||
    typeof intent.state !== 'string' ||
    facts.state !== intent.state
  ) {
    return freeze('resume_intent_not_authoritative');
  }

  if (intent.operation === 'initialize') {
    if (facts.productionSha === null || facts.productionSha === undefined) {
      return { action: 'continue_external_write', nextStep: 'create_production_ref' };
    }
    if (facts.productionSha === intent.targetSha) {
      return { action: 'finalize_completion', evidenceType: 'initialized' };
    }
    return freeze('initialize_ref_outside_intent');
  }

  if (intent.operation === 'adopt') {
    if (
      facts.productionSha !== intent.oldSha ||
      facts.currentDeploymentSha !== intent.oldSha ||
      facts.currentDeploymentId !== intent.expectedCurrentDeploymentId ||
      facts.currentDeploymentReadyState !== intent.currentDeploymentReadyState ||
      facts.currentDeploymentTarget !== intent.currentDeploymentTarget
    ) {
      return freeze('adopt_current_production_changed');
    }
    return { action: 'finalize_completion', evidenceType: 'adopted' };
  }

  if (intent.operation === 'stage') {
    if (facts.currentDeploymentId !== intent.expectedCurrentDeploymentId) {
      return freeze('stage_current_deployment_changed');
    }
    const deployments = Array.isArray(facts.matchingDeployments)
      ? facts.matchingDeployments
      : [];
    if (facts.productionSha === intent.oldSha) {
      if (deployments.length !== 0) return freeze('stage_deployment_before_ref');
      return { action: 'continue_external_write', nextStep: 'push_production_ref' };
    }
    if (facts.productionSha !== intent.targetSha) return freeze('stage_ref_outside_intent');
    if (deployments.length === 0) {
      return { action: 'continue_external_write', nextStep: 'build_and_stage_deployment' };
    }
    if (deployments.length === 1) {
      return {
        action: 'finalize_completion',
        evidenceType: 'staged_pending_promote',
      };
    }
    return freeze('multiple_matching_deployments');
  }

  if (intent.operation === 'promote') {
    if (facts.currentDeploymentId === intent.expectedCurrentDeploymentId) {
      return { action: 'continue_external_write', nextStep: 'promote_deployment' };
    }
    if (facts.currentDeploymentId === intent.deploymentId) {
      return {
        action: 'finalize_completion',
        evidenceType: 'production_acceptance',
      };
    }
    return freeze('promote_current_outside_intent');
  }

  if (intent.operation === 'rollback') {
    if (facts.currentDeploymentId === intent.currentDeploymentId) {
      return { action: 'continue_external_write', nextStep: 'rollback_deployment' };
    }
    if (facts.currentDeploymentId !== intent.targetDeploymentId) {
      return freeze('rollback_current_outside_intent');
    }
    if (facts.settingsMatch !== true) {
      return { action: 'continue_external_write', nextStep: 'restore_vercel_settings' };
    }
    return { action: 'finalize_completion', evidenceType: 'rolled_back' };
  }

  if (intent.operation === 'renew') {
    if (!['initialized', 'staged_pending_promote'].includes(intent.renewState)) {
      return freeze('renew_state_invalid');
    }
    return { action: 'continue_external_write', nextStep: 'renew_evidence' };
  }

  if (intent.operation === 'fail') {
    return { action: 'continue_external_write', nextStep: 'record_stage_failed' };
  }

  return freeze('intent_operation_unknown');
}
