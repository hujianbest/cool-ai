type FieldError = { field: string; code: string };

export class MemoryError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: FieldError[],
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export class MemorySourceResolutionError extends Error {
  readonly code = "INVALID_SOURCE";
  readonly httpStatus = 400;

  constructor() {
    super("Memory source is invalid.");
    this.name = "MemorySourceResolutionError";
  }
}

export class ReviewMemoryCommitError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReviewMemoryCommitError";
  }
}
