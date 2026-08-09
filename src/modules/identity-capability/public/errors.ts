export class ProviderServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: Array<{ field: string; code: string }>,
  ) {
    super(message);
    this.name = "ProviderServiceError";
  }
}

export class AgentServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: Array<{ field: string; code: string }>,
  ) {
    super(message);
    this.name = "AgentServiceError";
  }
}

export class SkillServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: Array<{ field: string; code: string }>,
  ) {
    super(message);
    this.name = "SkillServiceError";
  }
}

export type CredentialVaultErrorCode =
  | "MASTER_KEY_UNAVAILABLE"
  | "PROVIDER_KEY_UNAVAILABLE"
  | "PROVIDER_KEY_CORRUPT"
  | "VALIDATION_EXPIRED"
  | "VALIDATION_MISMATCH";

export class CredentialVaultError extends Error {
  constructor(public readonly code: CredentialVaultErrorCode, message: string) {
    super(message);
    this.name = "CredentialVaultError";
  }
}
