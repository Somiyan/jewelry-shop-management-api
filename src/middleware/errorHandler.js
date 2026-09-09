function notFound(req, res, next) {
  res.status(404).json({ message: `Route not found: ${req.originalUrl}` });
}

function errorHandler(err, req, res, next) {
  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  // Some errors carry structured, controller-attached data meant for the
  // client — e.g. paymentService's `outstanding`, or the Sales module's
  // `warnings`/`requiresApproval` on a below-current-value rejection. `status`
  // is consumed via res.statusCode above and excluded here to avoid duplicating it.
  const { message, stack, status, ...extra } = err;
  res.status(statusCode).json({
    message: message || 'Internal server error',
    stack: process.env.NODE_ENV === 'production' ? undefined : stack,
    ...extra,
  });
}

module.exports = { notFound, errorHandler };
