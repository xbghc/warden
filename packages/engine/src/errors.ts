export class WardenError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'WardenError';
  }
}

export function badRequest(message: string, code = 'bad_request'): WardenError {
  return new WardenError(400, message, code);
}

export function notFound(message: string, code = 'not_found'): WardenError {
  return new WardenError(404, message, code);
}
