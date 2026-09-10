// Express 4 does NOT automatically catch a rejected promise thrown inside an async route
// handler - without this wrapper, an error in any `async (req, res) => {...}` handler would
// either hang the request or surface as an opaque HTML 500 page instead of a clean JSON error.
// Wrapping every route in this fixes that class of bug across the whole app in one place.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
