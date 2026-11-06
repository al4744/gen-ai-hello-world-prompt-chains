import "server-only";
import type { ErrorCode, ProviderMetadata } from "./types";

const messages: Record<ErrorCode, string> = {
  input_invalid: "The input image or context could not be verified.",
  provider_error: "The AI provider could not complete this execution.",
  provider_timeout: "The AI request did not complete within its time budget.",
  output_invalid: "The generated output did not meet the execution contract.",
  artifact_error: "The captioned image could not be validated or saved.",
  persistence_error: "Execution could not be confirmed. Review the saved run before trying again.",
  access_denied: "Superadmin access to your own run is required.",
  contract_mismatch: "The saved execution configuration is unsupported or inconsistent.",
  provider_not_configured: "AI generation is not configured.",
  renderer_unavailable: "Captioned-image rendering is not integrated yet.",
  cancelled: "Execution was cancelled. A started AI request will not be retried.",
  deadline_exceeded: "There is insufficient time to safely finish this execution.",
  execution_conflict: "This execution is already being processed or its state changed.",
};

export class ExecutionFault extends Error {
  constructor(readonly code: ErrorCode, readonly metadata?: ProviderMetadata) {
    super(messages[code]); this.name = "ExecutionFault";
  }
}
export function fault(error: unknown, fallback: ErrorCode = "persistence_error"): ExecutionFault {
  return error instanceof ExecutionFault ? error : new ExecutionFault(fallback);
}
export function publicError(error: ExecutionFault) {
  return { code: error.code, message: messages[error.code] };
}
