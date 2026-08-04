'use strict';

function normalizePressCount(value) {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || ![1, 2].includes(value)) return null;
  return value;
}

module.exports = { normalizePressCount };
