function trimTrailingPathSeparators(value: string): string {
  if (value === "/") {
    return value;
  }
  if (/^[A-Za-z]:[\\/]?$/.test(value)) {
    return `${value.slice(0, 2)}\\`;
  }
  return value.replace(/[\\/]+$/, "");
}

function getPathParent(value: string): string {
  const trimmed = trimTrailingPathSeparators(value);
  if (trimmed === "/") {
    return trimmed;
  }
  if (/^[A-Za-z]:\\$/.test(trimmed)) {
    return trimmed;
  }

  const lastSeparatorIndex = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (lastSeparatorIndex < 0) {
    return "";
  }
  if (lastSeparatorIndex === 0) {
    return "/";
  }
  if (lastSeparatorIndex === 2 && /^[A-Za-z]:/.test(trimmed)) {
    return `${trimmed.slice(0, 2)}\\`;
  }
  return trimmed.slice(0, lastSeparatorIndex);
}

export { getPathParent, trimTrailingPathSeparators };
