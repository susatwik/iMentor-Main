function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function isDebugMode(req = {}) {
  const isProduction = (process.env.NODE_ENV || 'development') === 'production';
  const isAdmin = req?.user?.isAdmin === true || req?.user?.role === 'admin';
  return !isProduction && isAdmin;
}

module.exports = {
  isDebugMode,
  parseBooleanFlag,
};
