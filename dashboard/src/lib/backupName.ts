/** Default to a readable, locale-independent local date; `/` is not a valid filename character. */
export function defaultBackupName(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `Backup ${month}-${day}-${date.getFullYear()}`;
}
