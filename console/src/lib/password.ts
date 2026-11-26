/** The shortest password Northlight accepts. Supabase is set to the same (`minimum_password_length` in supabase/config.toml). */
export const MIN_PASSWORD = 10;
// Supabase stores passwords with bcrypt, which ignores everything after 72 bytes.
const MAX_PASSWORD_BYTES = 72;

/** What is wrong with a new password, in words, or null when it is fine. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return "Use 72 characters or fewer.";
  return null;
}
