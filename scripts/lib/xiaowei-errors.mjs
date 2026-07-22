export class XiaoweiError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "XiaoweiError";
    this.code = code;
    this.details = details;
  }
}

export function toErrorResult(error) {
  if (error instanceof XiaoweiError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "XIAOWEI_INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  };
}
