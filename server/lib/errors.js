'use strict';
/** Errors that are safe to show to an operator. Anything else is logged and shown as a generic message. */
class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', extra) {
    super(message); this.status = status; this.code = code; this.expose = true; if (extra) this.extra = extra;
  }
}
class BadRequest extends AppError { constructor(m, extra) { super(m, 400, 'BAD_REQUEST', extra); } }
class Unauthorized extends AppError { constructor(m = 'Please login') { super(m, 401, 'UNAUTHORIZED'); } }
class Forbidden extends AppError { constructor(m = 'Insufficient permission.') { super(m, 403, 'FORBIDDEN'); } }
class NotFound extends AppError { constructor(m = 'Not found') { super(m, 404, 'NOT_FOUND'); } }
class Conflict extends AppError { constructor(m, extra) { super(m, 409, 'CONFLICT', extra); } }
/** Thrown when an action needs a higher-authority user to approve (manager PIN). */
class ApprovalRequired extends AppError {
  constructor(m, action, extra) { super(m, 403, 'APPROVAL_REQUIRED', { action, ...extra }); }
}
module.exports = { AppError, BadRequest, Unauthorized, Forbidden, NotFound, Conflict, ApprovalRequired };
