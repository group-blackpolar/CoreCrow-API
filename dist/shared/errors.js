export class DomainError extends Error {
    statusCode;
    code;
    details;
    constructor(statusCode, code, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}
export function fail(status, code, message) {
    throw new DomainError(status, code, message);
}
