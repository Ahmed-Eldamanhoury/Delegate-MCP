export const EVENT_TYPES = Object.freeze({
  JOB_QUEUED: "JobQueued",
  JOB_STATE_CHANGED: "JobStateChanged",
  JOB_PROGRESS: "JobProgress",
  OUTPUT_CHUNK: "OutputChunk",
  JOB_COMPLETED: "JobCompleted",
  JOB_FAILED: "JobFailed",
  JOB_CANCELLED: "JobCancelled",
  ARTIFACT_CREATED: "ArtifactCreated",
  WORKSPACE_CREATED: "WorkspaceCreated",
  WORKSPACE_DELETED: "WorkspaceDeleted",
});

export const EVENT_SCHEMA_VERSION = 1;

/**
 * @typedef {Object} RuntimeEvent
 * @property {string} eventId
 * @property {string} timestamp ISO-8601
 * @property {string} jobId
 * @property {string} type one of EVENT_TYPES
 * @property {number} version event *schema* version (frozen at 1 by ADR-0002)
 * @property {object} payload shape depends on `type` — see ADR-0002's event table
 */
