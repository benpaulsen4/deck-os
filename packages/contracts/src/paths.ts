function trimTrailingPathSeparators(value: string): string {
  if (value === "/") {
    return value;
  }
  if (/^[A-Za-z]:[\\/]?$/.test(value)) {
    return `${value.slice(0, 2)}\\`;
  }
  let end = value.length;
  while (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code !== 47 && code !== 92) {
      break;
    }
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
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
