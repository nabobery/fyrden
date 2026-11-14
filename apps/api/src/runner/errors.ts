// Every message the runner protocol sends a runner. The pinned runner stops
// for good on any error whose message ends in "unregistered runner"
// (measured, and read in its client), so none may end that way, and a message
// built from a request's text keeps that text away from its end; a test checks
// each export here.

export const PROTOBUF_ONLY = "only binary protobuf is supported";

export function encodingUnsupported(header: string, encoding: string): string {
  return `${header} ${encoding} is not supported`;
}

export function unknownMethod(method: string): string {
  return `method ${method} is not implemented by this server`;
}

export const NOT_AVAILABLE = "this method is not available yet on this server";

export const BODY_TOO_LARGE = "the request body is larger than this method accepts";

export const INVALID_MESSAGE = "the request is not a valid protobuf message";

export const RATE_LIMITED = "too many runner requests from this address; retry later";

export const REGISTRATION_OFF = "runner registration is turned off on this deployment";

export const REGISTRATION_REFUSED =
  "the registration token is not valid: it is unknown, expired or already used";

export const NAME_REQUIRED = "a runner name is required";

export const FIELD_TOO_LONG = "a runner name, version or label is too long";

export const TOO_MANY_LABELS = "a runner may declare at most 64 labels";

export const CREDENTIALS_REFUSED = "the runner's credentials are not valid";
