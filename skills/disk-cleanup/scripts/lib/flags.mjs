/** `--flag a b c` collects values up to the next `--flag`; a repeated flag adds to its list. */
export function parseFlags(args) {
  const flags = {};
  let current = null;
  for (const arg of args) {
    if (arg.startsWith('--')) {
      current = arg.slice(2);
      flags[current] ??= [];
    } else if (current) {
      flags[current].push(arg);
    }
  }
  return flags;
}
