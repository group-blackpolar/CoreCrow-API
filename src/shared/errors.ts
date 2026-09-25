export class DomainError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new DomainError(status, code, message);
}
