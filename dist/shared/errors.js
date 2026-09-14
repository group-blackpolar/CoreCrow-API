export class DomainError extends Error {
    statusCode;
    code;
    constructor(statusCode, code, message) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}
export function fail(status, code, message) {
    throw new DomainError(status, code, message);
}
