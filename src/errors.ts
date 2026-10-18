export type ErrorCode =
  | "invalid_parameter"
  | "invalid_url"
  | "blocked_url"
  | "too_many_redirects"
  | "upstream_timeout"
  | "upstream_fetch_failed"
  | "source_too_large"
  | "input_too_large"
  | "unsupported_media_type"
  | "image_processing_failed"
  | "rate_limited"
  | "overloaded"
  | "not_found"
  | "internal_error";

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    param?: string;
  };
};

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly param?: string;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options?: { param?: string; headers?: Record<string, string> },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.param = options?.param;
    this.headers = options?.headers;
  }

  toBody(): ErrorBody {
    const error: ErrorBody["error"] = {
      code: this.code,
      message: this.message,
    };
    if (this.param !== undefined) error.param = this.param;
    return { error };
  }
}

export class ClientAbortedError extends Error {
  constructor() {
    super("client closed the request");
    this.name = "ClientAbortedError";
  }
}
