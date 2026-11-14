/** UTC metadata is an explicit instant, never a date silently promoted to midnight.
 * Field precision and rounding are deferred; this module does not implement numeric conversion.
 */
export function isExplicitUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (!matched || matched[1] === '0000') return false;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  const canonical = `${value.slice(0, 19)}.${(matched[7] ?? '').padEnd(3, '0')}Z`;
  return new Date(epoch).toISOString() === canonical;
}
