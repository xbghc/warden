export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function badRequest(message: string, code = 'bad_request'): HttpError {
  return new HttpError(400, message, code);
}

export function notFound(message: string, code = 'not_found'): HttpError {
  return new HttpError(404, message, code);
}
